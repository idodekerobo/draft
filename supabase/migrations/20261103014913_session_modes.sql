-- The modes a session is in, and a control input to change them.
-- permission_mode: Claude's four modes (and two launch-only ones), or Codex's collaboration mode (default, plan).
-- approval_mode: Codex only.
alter table sessions
  add column permission_mode text
    check (permission_mode in ('default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk')),
  add column approval_mode text
    check (approval_mode in ('ask-for-approval', 'approve-for-me', 'full-access'));

alter table session_inputs drop constraint session_inputs_kind_check;
alter table session_inputs add constraint session_inputs_kind_check
  check (kind in ('message', 'permission_decision', 'stop', 'end', 'set_mode'));

-- The old four-argument function is dropped so a call resolves to the new one through defaults.
drop function if exists heartbeat_session(uuid, uuid, text, text);

-- Records that the host is alive, and the modes the session is in. A host_offline session returns to live.
-- A session that is still starting stays starting. Writes for an ended session
-- or from another host are rejected.
create or replace function heartbeat_session(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_machine_id text,
  p_harness_version text default null,
  p_permission_mode text default null,
  p_approval_mode text default null
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
      harness_version = coalesce(p_harness_version, harness_version),
      permission_mode = coalesce(p_permission_mode, permission_mode),
      approval_mode = coalesce(p_approval_mode, approval_mode)
  where id = p_session_id;

  return v_status;
end;
$$;

revoke all on function heartbeat_session(uuid, uuid, text, text, text, text) from public;
grant execute on function heartbeat_session(uuid, uuid, text, text, text, text) to service_role;
