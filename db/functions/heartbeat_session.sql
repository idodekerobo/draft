-- Records that the host is alive. A host_offline session returns to live.
-- A session that is still starting stays starting. Writes for an ended session
-- or from another host are rejected.
create or replace function heartbeat_session(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_machine_id text,
  p_harness_version text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session sessions%rowtype;
  v_status text;
begin
  select * into v_session
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_session.status = 'ended' then
    raise exception 'session_ended';
  end if;
  if v_session.host_machine_id is distinct from p_host_machine_id then
    raise exception 'foreign_host';
  end if;

  v_status := case when v_session.status = 'host_offline' then 'live' else v_session.status end;

  update sessions
  set last_seen = now(),
      status = v_status,
      harness_version = coalesce(p_harness_version, harness_version)
  where id = p_session_id;

  return v_status;
end;
$$;

revoke all on function heartbeat_session(uuid, uuid, text, text) from public;
grant execute on function heartbeat_session(uuid, uuid, text, text) to service_role;
