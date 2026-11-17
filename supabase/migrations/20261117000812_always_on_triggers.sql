-- Always-on triggers: one-shot timers, agent-made routines, and a durable event inbox.

-- scheduled_tasks: 'once' timers and who made each routine.
alter table scheduled_tasks drop constraint if exists scheduled_tasks_schedule_kind_check;
alter table scheduled_tasks drop constraint if exists scheduled_tasks_check;

alter table scheduled_tasks
  add column run_at timestamptz,
  add column fired_at timestamptz,
  add column created_via text not null default 'app'
    check (created_via in ('app', 'cli', 'mcp', 'run', 'system')),
  add column created_by_run_id uuid,
  add column trigger_depth integer not null default 0 check (trigger_depth >= 0),
  add column visibility text not null default 'shared'
    check (visibility in ('private', 'shared'));

update scheduled_tasks set created_via = 'system' where task_type <> 'agent_routine';

alter table scheduled_tasks
  add constraint scheduled_tasks_schedule_kind_check
    check (schedule_kind in ('cron', 'interval', 'once')),
  add constraint scheduled_tasks_schedule_shape check (
    (schedule_kind = 'cron' and cron_expression is not null and interval_seconds is null and run_at is null)
    or (schedule_kind = 'interval' and interval_seconds is not null and cron_expression is null and run_at is null)
    or (schedule_kind = 'once' and run_at is not null and cron_expression is null and interval_seconds is null)
  ),
  add constraint scheduled_tasks_created_by_run
    check ((created_via = 'run') = (created_by_run_id is not null)),
  add constraint scheduled_tasks_created_by_run_fkey
    foreign key (created_by_run_id, workspace_id) references agent_runs(id, workspace_id);

create index scheduled_tasks_due_idx on scheduled_tasks (next_due_at)
  where enabled and deleted_at is null and next_due_at is not null;
create index scheduled_tasks_created_by_run_idx on scheduled_tasks (created_by_run_id)
  where created_by_run_id is not null;

-- agent_events: the inbox. One row per (routine, thing that should wake it).
create table agent_events (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  scheduled_task_id  uuid not null,
  origin             text not null check (origin in ('schedule', 'webhook', 'manual', 'agent')),
  event_name         text not null,
  dedupe_key         text not null,
  concurrency_key    text not null,
  source_item_id     uuid,
  payload            jsonb not null default '{}',
  status             text not null default 'pending'
                       check (status in ('pending', 'claimed', 'done', 'skipped', 'failed', 'dead')),
  attempts           integer not null default 0,
  lease_until        timestamptz,
  claimed_by_run_id  uuid,
  failure_code       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (id, workspace_id),
  unique (workspace_id, dedupe_key),
  foreign key (scheduled_task_id, workspace_id) references scheduled_tasks(id, workspace_id),
  foreign key (source_item_id, workspace_id) references source_items(id, workspace_id),
  foreign key (claimed_by_run_id, workspace_id) references agent_runs(id, workspace_id)
);

create index agent_events_ready_idx on agent_events (created_at) where status = 'pending';
create index agent_events_lease_idx on agent_events (lease_until) where status = 'claimed';
create index agent_events_task_key_idx on agent_events (scheduled_task_id, concurrency_key)
  where status in ('pending', 'claimed');

alter table agent_events enable row level security;
grant select, insert, update on table agent_events to service_role;

-- agent_run_events: which events each run consumed.
create table agent_run_events (
  agent_run_id    uuid not null,
  agent_event_id  uuid not null,
  workspace_id    uuid not null,
  primary key (agent_run_id, agent_event_id),
  foreign key (agent_run_id, workspace_id) references agent_runs(id, workspace_id) on delete cascade,
  foreign key (agent_event_id, workspace_id) references agent_events(id, workspace_id) on delete cascade
);

alter table agent_run_events enable row level security;
grant select, insert, update on table agent_run_events to service_role;

-- sessions: one live run per (routine, concurrency key), across backend instances.
alter table sessions add column concurrency_key text;

create unique index sessions_one_live_per_key_idx on sessions (scheduled_task_id, concurrency_key)
  where concurrency_key is not null and status in ('starting', 'live', 'host_offline');

-- Claims due timers with SKIP LOCKED. Agent routines get their agent_events row in this
-- same transaction, so a crash after the claim can't lose a one-shot. Other tasks get a
-- provisional next_due_at (p_now + lease) that the caller replaces; SQL can't parse cron.
create or replace function claim_due_scheduled_tasks(
  p_now timestamptz,
  p_limit int,
  p_lease_seconds int
)
returns table (task jsonb, occurrence_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
    with due as (
      select s.id, s.next_due_at as occurrence_at
      from scheduled_tasks s
      where s.enabled
        and s.deleted_at is null
        and s.next_due_at is not null
        and s.next_due_at <= p_now
      order by s.next_due_at
      limit p_limit
      for update skip locked
    ), routine_events as (
      insert into agent_events (workspace_id, scheduled_task_id, origin, event_name, dedupe_key, concurrency_key, payload)
      select t.workspace_id, t.id, 'schedule', 'timer.fired',
             t.id::text || ':timer:' || to_char(d.occurrence_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             t.id::text,
             jsonb_build_object(
               'type', 'timer',
               'occurrenceAt', to_char(d.occurrence_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             )
      from scheduled_tasks t
      join due d on d.id = t.id
      where t.task_type = 'agent_routine'
      on conflict (workspace_id, dedupe_key) do nothing
    )
    update scheduled_tasks t set
      last_enqueued_at = p_now,
      fired_at    = case when t.schedule_kind = 'once' then p_now else t.fired_at end,
      enabled     = case when t.schedule_kind = 'once' then false else t.enabled end,
      next_due_at = case when t.schedule_kind = 'once' then null
                         else p_now + make_interval(secs => p_lease_seconds) end
    from due
    where t.id = due.id
    returning to_jsonb(t.*), due.occurrence_at;
end;
$$;

revoke all on function claim_due_scheduled_tasks(timestamptz, int, int) from public;
grant execute on function claim_due_scheduled_tasks(timestamptz, int, int) to service_role;

-- Claims up to p_limit inbox events: pending, or claimed with an expired lease.
-- Events whose lease expired after 3 attempts are marked dead first.
create or replace function claim_agent_events(
  p_limit int,
  p_lease_seconds int
)
returns setof agent_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  update agent_events
  set status = 'dead',
      failure_code = coalesce(failure_code, 'lease_expired'),
      updated_at = now()
  where status = 'claimed'
    and lease_until < now()
    and attempts >= 3;

  select array_agg(id) into v_ids
  from (
    select id
    from agent_events
    where status = 'pending'
       or (status = 'claimed' and lease_until < now())
    order by created_at asc
    limit p_limit
    for update skip locked
  ) eligible;

  if v_ids is null then
    return;
  end if;

  return query
    update agent_events
    set status = 'claimed',
        lease_until = now() + make_interval(secs => p_lease_seconds),
        attempts = attempts + 1,
        updated_at = now()
    where id = any(v_ids)
    returning *;
end;
$$;

revoke all on function claim_agent_events(int, int) from public;
grant execute on function claim_agent_events(int, int) to service_role;
