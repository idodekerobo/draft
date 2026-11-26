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
