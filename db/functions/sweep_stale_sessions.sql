-- Marks sessions whose host has not sent a heartbeat for p_stale_after as host_offline.
-- Routine sessions are skipped: they send no heartbeat, and the tick fails them on a timeout.
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
    and last_seen < now() - p_stale_after;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function sweep_stale_sessions(interval) from public;
grant execute on function sweep_stale_sessions(interval) to service_role;
