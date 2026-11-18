-- Rename agent_events to agent_event_inbox: the table is the inbox, each row an agent event.
-- Drop agent_run_events: each event goes to at most one run, which agent_event_inbox.claimed_by_run_id
-- already records.

drop table agent_run_events;

alter table agent_events rename to agent_event_inbox;

alter index agent_events_ready_idx rename to agent_event_inbox_ready_idx;
alter index agent_events_lease_idx rename to agent_event_inbox_lease_idx;
alter index agent_events_task_key_idx rename to agent_event_inbox_task_key_idx;

-- Default-named constraints (pkey, unique, check, foreign keys) still start with agent_events_.
do $$
declare
  r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.agent_event_inbox'::regclass and conname like 'agent_events\_%'
  loop
    execute format('alter table agent_event_inbox rename constraint %I to %I',
                   r.conname, 'agent_event_inbox_' || substr(r.conname, length('agent_events_') + 1));
  end loop;
end;
$$;

-- Function bodies name the table as text, so a rename doesn't reach them. Recreate both.
drop function claim_agent_events(int, int);

-- Claims up to p_limit inbox events: pending, or claimed with an expired lease.
-- Events whose lease expired after 3 attempts are marked dead first, each with an errors row.
create or replace function claim_agent_event_inbox(
  p_limit int,
  p_lease_seconds int
)
returns setof agent_event_inbox
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  with dead as (
    update agent_event_inbox
    set status = 'dead',
        failure_code = coalesce(failure_code, 'lease_expired'),
        updated_at = now()
    where status = 'claimed'
      and lease_until < now()
      and attempts >= 3
    returning id, workspace_id, scheduled_task_id, attempts, failure_code
  )
  insert into errors (workspace_id, scheduled_task_id, operation, message, detail_json)
  select workspace_id, scheduled_task_id, 'scheduling',
         'An inbox event''s lease expired after ' || attempts || ' attempts, so it will not run',
         jsonb_build_object('code', 'agent_event_dead', 'event_id', id, 'failure_code', failure_code)
  from dead;

  select array_agg(id) into v_ids
  from (
    select id
    from agent_event_inbox
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
    update agent_event_inbox
    set status = 'claimed',
        lease_until = now() + make_interval(secs => p_lease_seconds),
        attempts = attempts + 1,
        updated_at = now()
    where id = any(v_ids)
    returning *;
end;
$$;

revoke all on function claim_agent_event_inbox(int, int) from public;
grant execute on function claim_agent_event_inbox(int, int) to service_role;

-- Claims due timers with SKIP LOCKED. Agent routines get their agent_event_inbox row in this
-- same transaction, so a crash after the claim can't lose a one-shot. Other tasks get a
-- provisional next_due_at (p_now + lease) that the caller replaces; SQL can't parse cron.
-- claimed_occurrence_at keeps the real occurrence until the caller advances the row, so a
-- reclaim after a crash reuses it and the event's dedupe key, instead of firing again.
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
      select s.id, coalesce(s.claimed_occurrence_at, s.next_due_at) as occurrence_at
      from scheduled_tasks s
      where s.enabled
        and s.deleted_at is null
        and s.next_due_at is not null
        and s.next_due_at <= p_now
      order by s.next_due_at
      limit p_limit
      for update skip locked
    ), routine_events as (
      insert into agent_event_inbox (workspace_id, scheduled_task_id, origin, event_name, dedupe_key, concurrency_key, payload)
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
      claimed_occurrence_at = case when t.schedule_kind = 'once' then null else due.occurrence_at end,
      next_due_at = case when t.schedule_kind = 'once' then null
                         else p_now + make_interval(secs => p_lease_seconds) end
    from due
    where t.id = due.id
    returning to_jsonb(t.*), due.occurrence_at;
end;
$$;

revoke all on function claim_due_scheduled_tasks(timestamptz, int, int) from public;
grant execute on function claim_due_scheduled_tasks(timestamptz, int, int) to service_role;
