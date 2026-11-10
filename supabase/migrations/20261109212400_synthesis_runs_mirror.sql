-- Every synthesis run also exists as an agent run, with the same id. synthesis_runs stays the source of
-- truth, and nothing that reads or writes it changes. A trigger copies each change to agent_runs, so a
-- later step can move readers over without a gap.
--
-- To undo this: drop the two triggers below. agent_runs rows of kind 'synthesis' can then be deleted.

-- The sources a run was given, as synthesis_run_source_items holds them.
create table agent_run_source_items (
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  agent_run_id             uuid not null,
  source_item_id           uuid not null,
  position                 integer not null check (position >= 0),
  source_item_version      text not null,
  content_hash             text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at               timestamptz not null default now(),

  primary key (agent_run_id, source_item_id),
  unique (agent_run_id, position),
  foreign key (agent_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete cascade,
  foreign key (source_item_id, workspace_id)
    references source_items(id, workspace_id) on delete restrict
);

create index agent_run_source_items_source_item_idx
  on agent_run_source_items (source_item_id, workspace_id, source_item_version, content_hash)
  include (agent_run_id);

alter table agent_run_source_items enable row level security;
grant select, insert on table agent_run_source_items to service_role;

-- The agent run a synthesis run corresponds to. Written once here so the trigger and the backfill agree.
create or replace function mirror_synthesis_run(p_run synthesis_runs)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trigger jsonb;
  v_retry_of uuid;
begin
  if p_run.trigger_type = 'schedule' and p_run.scheduled_task_id is not null and position(':' in p_run.idempotency_key) > 0 then
    -- The idempotency key of a scheduled run is "<task id>:<occurrence time>".
    v_trigger := jsonb_build_object(
      'type', 'cron',
      'scheduledTaskId', p_run.scheduled_task_id,
      'occurrenceAt', substr(p_run.idempotency_key, position(':' in p_run.idempotency_key) + 1)
    );
  elsif p_run.trigger_type = 'retry' and p_run.retry_of_run_id is not null then
    v_trigger := jsonb_build_object('type', 'retry', 'retryOf', p_run.retry_of_run_id);
  else
    v_trigger := jsonb_build_object('type', 'system', 'reason', p_run.trigger_type);
  end if;

  -- A retry points at a run that is already mirrored, or at nothing.
  select id into v_retry_of from agent_runs where id = p_run.retry_of_run_id and workspace_id = p_run.workspace_id;

  insert into agent_runs (
    id, workspace_id, kind, trigger, principal, runtime, harness, model, instructions,
    base_context_version_id, permissions, output, status, attempt, retry_of_run_id,
    idempotency_key, prompt_version, sandbox_machine_id, summary, failure_code,
    started_at, completed_at, created_at, updated_at
  ) values (
    p_run.id, p_run.workspace_id, 'synthesis', v_trigger,
    '{"type": "workspace"}'::jsonb,
    '{"type": "cloud", "environment": {"nativeTools": [{"harness": "claude", "tool": "Read"}, {"harness": "claude", "tool": "Glob"}], "mcpServers": [], "skills": [], "instructions": []}}'::jsonb,
    'claude', null, '',
    p_run.base_context_version_id, '[]'::jsonb, '{"type": "structured", "schema": {}}'::jsonb,
    p_run.status, p_run.attempt, v_retry_of,
    p_run.idempotency_key, p_run.prompt_version, p_run.sandbox_machine_id, p_run.result_summary,
    case when p_run.status in ('failed', 'stale') then coalesce(p_run.outcome, p_run.status) end,
    p_run.started_at, p_run.completed_at, p_run.created_at, p_run.updated_at
  )
  on conflict (id) do update set
    status = excluded.status,
    attempt = excluded.attempt,
    sandbox_machine_id = excluded.sandbox_machine_id,
    summary = excluded.summary,
    failure_code = excluded.failure_code,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at;
end;
$$;

revoke all on function mirror_synthesis_run(synthesis_runs) from public;

-- The mirror must never stop synthesis. If copying fails, synthesis goes on and the problem is a warning.
create or replace function mirror_synthesis_run_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform mirror_synthesis_run(new);
  exception when others then
    raise warning 'mirror_synthesis_run failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

create trigger synthesis_runs_mirror
  after insert or update on synthesis_runs
  for each row execute function mirror_synthesis_run_trigger();

create or replace function mirror_synthesis_run_source_item_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    insert into agent_run_source_items (
      workspace_id, agent_run_id, source_item_id, position, source_item_version, content_hash, created_at
    ) values (
      new.workspace_id, new.synthesis_run_id, new.source_item_id, new.position, new.source_item_version, new.content_hash, new.created_at
    )
    on conflict do nothing;
  exception when others then
    raise warning 'mirror of source item % for run % failed: %', new.source_item_id, new.synthesis_run_id, sqlerrm;
  end;
  return new;
end;
$$;

create trigger synthesis_run_source_items_mirror
  after insert on synthesis_run_source_items
  for each row execute function mirror_synthesis_run_source_item_trigger();

-- Backfill: every run so far, oldest first so a retry finds the run it retries.
do $$
declare
  v_run synthesis_runs;
begin
  for v_run in select * from synthesis_runs order by created_at, id loop
    perform mirror_synthesis_run(v_run);
  end loop;
end $$;

insert into agent_run_source_items (workspace_id, agent_run_id, source_item_id, position, source_item_version, content_hash, created_at)
select srsi.workspace_id, srsi.synthesis_run_id, srsi.source_item_id, srsi.position, srsi.source_item_version, srsi.content_hash, srsi.created_at
from synthesis_run_source_items srsi
where exists (select 1 from agent_runs ar where ar.id = srsi.synthesis_run_id and ar.workspace_id = srsi.workspace_id)
on conflict do nothing;
