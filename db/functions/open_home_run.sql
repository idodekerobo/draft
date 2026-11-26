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
