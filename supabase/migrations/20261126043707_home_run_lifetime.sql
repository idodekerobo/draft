-- The run of a Home work episode: opened on the first admitted input, ended when no work is pending, and the stale-session sweep leaves Home alone.

-- Marks sessions whose host has not sent a heartbeat for p_stale_after as host_offline.
-- Routine sessions are skipped: they send no heartbeat, and the tick fails them on a timeout.
-- An embedded agent's session (execution target backend, such as Home) is skipped: no host sends a heartbeat for it, and its
-- liveness is its owner claim. It is picked out by its target, never by a list of run kinds to leave out.
-- The scheduler tick calls it. The same host's next heartbeat or append sets the session back to live.
create or replace function sweep_stale_sessions(p_stale_after interval default interval '60 seconds')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update sessions
  set status = 'host_offline'
  where status in ('starting', 'live')
    and session_type = 'interactive'
    and execution_target is distinct from 'backend'
    and last_seen < now() - p_stale_after;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function sweep_stale_sessions(interval) from public;
grant execute on function sweep_stale_sessions(interval) to service_role;

-- Opens the run of a work episode on an embedded agent's session (Home), or returns the one already open. One run covers
-- one episode of work, not one wake. It takes the session row lock, as settle_home_run does, so a new input never joins a run
-- that is closing. p_row holds the run's columns (the AgentRunSpec as the run store saves it).
create or replace function open_home_run(p_session_id uuid, p_row jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_workspace uuid;
  v_run uuid;
  r agent_runs;
begin
  select workspace_id into v_workspace from sessions
  where id = p_session_id and execution_target = 'backend' for update;
  if not found then
    raise exception 'session_not_found';
  end if;

  select id into v_run from agent_runs
  where session_id = p_session_id and status in ('queued', 'preparing', 'running', 'validating', 'committing');
  if found then
    return v_run;
  end if;

  r := jsonb_populate_record(null::agent_runs, p_row);
  insert into agent_runs (id, workspace_id, kind, trigger, on_behalf_of_user_id, execution, toolset, computer, continuation,
                          harness, model, reasoning_effort, instructions, base_context_version_id, permissions, output,
                          status, idempotency_key, session_id, started_at)
  values (r.id, v_workspace, r.kind, r.trigger, r.on_behalf_of_user_id, r.execution, r.toolset, r.computer, r.continuation,
          r.harness, r.model, r.reasoning_effort, coalesce(r.instructions, ''), r.base_context_version_id, coalesce(r.permissions, '[]'),
          coalesce(r.output, '{"type": "text"}'), 'running', r.idempotency_key, p_session_id, now());
  return r.id;
end;
$$;

revoke all on function open_home_run(uuid, jsonb) from public;
grant execute on function open_home_run(uuid, jsonb) to service_role;

-- Ends the open run of an embedded agent's session (Home) when no work is pending, and says whether it did. Pending work is a
-- message, decision, stop or model change not yet applied; a waiting question or approval; a turn, task or queued request
-- that is not a background watch. A background task does not hold the run: a child watch outlives the reply and starts a new
-- episode later. It takes the session row lock, as open_home_run does.
create or replace function settle_home_run(p_session_id uuid, p_run_id uuid, p_status text default 'succeeded')
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approvals integer;
begin
  if p_status not in ('succeeded', 'failed', 'cancelled') then
    raise exception 'invalid_status';
  end if;

  select open_approval_count into v_approvals from sessions
  where id = p_session_id and execution_target = 'backend' for update;
  if not found then
    raise exception 'session_not_found';
  end if;

  if p_status = 'succeeded' and (
    v_approvals > 0
    or exists (select 1 from session_inputs
               where session_id = p_session_id and kind in ('message', 'permission_decision', 'stop', 'set_mode')
                 and state in ('queued', 'delivering') and dismissed_at is null)
    or exists (select 1 from embedded_agent_records
               where session_id = p_session_id and record_type = 'task' and background is not true
                 and status in ('pending', 'running', 'waiting', 'sleeping', 'completing'))
    or exists (select 1 from embedded_agent_records
               where session_id = p_session_id and record_type = 'submission' and status in ('queued', 'placed'))
  ) then
    return false;
  end if;

  update agent_runs
  set status = p_status, completed_at = now(), updated_at = now()
  where id = p_run_id and session_id = p_session_id
    and status in ('queued', 'preparing', 'running', 'validating', 'committing');
  return found;
end;
$$;

revoke all on function settle_home_run(uuid, uuid, text) from public;
grant execute on function settle_home_run(uuid, uuid, text) to service_role;
