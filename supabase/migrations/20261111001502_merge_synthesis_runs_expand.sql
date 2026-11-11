-- Expand step of merging synthesis_runs into agent_runs. Nothing here removes or changes what the
-- current backend reads or writes. It adds the columns agent_runs lacks, links errors and events to
-- agent_runs, copies the old rows over, and teaches the mirror to copy the new columns.

-- 1. What synthesis keeps on its run, now on agent_runs.
alter table agent_runs
  add column needs_input_json         jsonb,
  add column needs_input_resolution   text,
  add column needs_input_resolved_at  timestamptz,
  add column needs_input_resolved_by  uuid references users(id) on delete set null,
  add column result_hash              text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  add column outcome                  text check (outcome in ('changed', 'no_change', 'failure', 'stale')),
  -- The full stream-json transcript of a run that does not stream to a session.
  add column transcript_json          jsonb,
  add column scheduled_task_id        uuid;

alter table agent_runs
  add foreign key (scheduled_task_id, workspace_id)
    references scheduled_tasks(id, workspace_id) on delete restrict;

-- 2. Errors and events can point at an agent run.
alter table errors add column agent_run_id uuid;
alter table errors
  add foreign key (agent_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete restrict;

alter table errors drop constraint errors_unattributed_has_no_links;
alter table errors add constraint errors_unattributed_has_no_links check (
  workspace_id is not null
  or (source_connection_id is null and scheduled_task_id is null and synthesis_run_id is null
      and agent_run_id is null and session_id is null)
);

alter table workspace_events add column agent_run_id uuid;
alter table workspace_events
  add foreign key (agent_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete restrict;

create index errors_agent_run_idx on errors (agent_run_id) where agent_run_id is not null;
create index workspace_events_agent_run_idx on workspace_events (agent_run_id) where agent_run_id is not null;

-- 3. The mirror copies the new columns too. (Same function as before, with the new columns added.)
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
    started_at, completed_at, created_at, updated_at,
    needs_input_json, needs_input_resolution, needs_input_resolved_at, needs_input_resolved_by,
    result_hash, outcome, transcript_json, scheduled_task_id
  ) values (
    p_run.id, p_run.workspace_id, 'synthesis', v_trigger,
    '{"type": "workspace"}'::jsonb,
    '{"type": "cloud", "environment": {"nativeTools": [{"harness": "claude", "tool": "Read"}, {"harness": "claude", "tool": "Glob"}], "mcpServers": [], "skills": [], "instructions": []}}'::jsonb,
    'claude', null, '',
    p_run.base_context_version_id, '[]'::jsonb, '{"type": "structured", "schema": {}}'::jsonb,
    p_run.status, p_run.attempt, v_retry_of,
    p_run.idempotency_key, p_run.prompt_version, p_run.sandbox_machine_id, p_run.result_summary,
    case when p_run.status in ('failed', 'stale') then coalesce(p_run.outcome, p_run.status) end,
    p_run.started_at, p_run.completed_at, p_run.created_at, p_run.updated_at,
    p_run.needs_input_json, p_run.needs_input_resolution, p_run.needs_input_resolved_at, p_run.needs_input_resolved_by,
    p_run.result_hash, p_run.outcome, p_run.transcript_json, p_run.scheduled_task_id
  )
  on conflict (id) do update set
    status = excluded.status,
    attempt = excluded.attempt,
    sandbox_machine_id = excluded.sandbox_machine_id,
    summary = excluded.summary,
    failure_code = excluded.failure_code,
    started_at = excluded.started_at,
    completed_at = excluded.completed_at,
    needs_input_json = excluded.needs_input_json,
    needs_input_resolution = excluded.needs_input_resolution,
    needs_input_resolved_at = excluded.needs_input_resolved_at,
    needs_input_resolved_by = excluded.needs_input_resolved_by,
    result_hash = excluded.result_hash,
    outcome = excluded.outcome,
    transcript_json = excluded.transcript_json,
    scheduled_task_id = excluded.scheduled_task_id;
end;
$$;

revoke all on function mirror_synthesis_run(synthesis_runs) from public;

-- 4. While the old backend can still write a synthesis_run_id, copy it to agent_run_id on insert.
-- A run is in both tables under one id. Dropped with synthesis_run_id when synthesis_runs goes.
create or replace function copy_synthesis_run_id_to_agent_run_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.agent_run_id is null and new.synthesis_run_id is not null
     and exists (select 1 from agent_runs where id = new.synthesis_run_id and workspace_id = new.workspace_id) then
    new.agent_run_id := new.synthesis_run_id;
  end if;
  return new;
end;
$$;

revoke all on function copy_synthesis_run_id_to_agent_run_id() from public;

create trigger errors_copy_run_id before insert on errors
  for each row execute function copy_synthesis_run_id_to_agent_run_id();
create trigger workspace_events_copy_run_id before insert on workspace_events
  for each row execute function copy_synthesis_run_id_to_agent_run_id();
create trigger workspace_context_versions_copy_run_id before insert on workspace_context_versions
  for each row execute function copy_synthesis_run_id_to_agent_run_id();

-- 5. Copy the history. updated_at keeps its value.
alter table agent_runs disable trigger agent_runs_set_updated_at;

update agent_runs a
set needs_input_json = s.needs_input_json,
    needs_input_resolution = s.needs_input_resolution,
    needs_input_resolved_at = s.needs_input_resolved_at,
    needs_input_resolved_by = s.needs_input_resolved_by,
    result_hash = s.result_hash,
    outcome = s.outcome,
    transcript_json = s.transcript_json,
    scheduled_task_id = s.scheduled_task_id
from synthesis_runs s
where a.id = s.id and a.workspace_id = s.workspace_id and a.kind = 'synthesis';

alter table agent_runs enable trigger agent_runs_set_updated_at;

update errors e set agent_run_id = e.synthesis_run_id
where e.synthesis_run_id is not null and e.agent_run_id is null
  and exists (select 1 from agent_runs a where a.id = e.synthesis_run_id and a.workspace_id = e.workspace_id);

update workspace_events w set agent_run_id = w.synthesis_run_id
where w.synthesis_run_id is not null and w.agent_run_id is null
  and exists (select 1 from agent_runs a where a.id = w.synthesis_run_id and a.workspace_id = w.workspace_id);

-- workspace_context_versions is append-only (no update grant for the app roles); this runs as the owner.
update workspace_context_versions v set agent_run_id = v.synthesis_run_id
where v.synthesis_run_id is not null and v.agent_run_id is null
  and exists (select 1 from agent_runs a where a.id = v.synthesis_run_id and a.workspace_id = v.workspace_id);
