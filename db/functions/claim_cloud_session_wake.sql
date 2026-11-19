-- Moves a sleeping cloud session to starting, so a wake can start its next run.
-- Returns true for the one caller that moved it, so two sends to a sleeping session start one run.
-- It also sets last_seen: the stale-session sweep would mark the new host host_offline before its first heartbeat.
create or replace function claim_cloud_session_wake(p_session_id uuid, p_workspace_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update sessions
  set status = 'starting',
      last_seen = now()
  where id = p_session_id and workspace_id = p_workspace_id
    and runtime = 'cloud' and status = 'sleeping' and deleted_at is null;

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function claim_cloud_session_wake(uuid, uuid) from public;
grant execute on function claim_cloud_session_wake(uuid, uuid) to service_role;
