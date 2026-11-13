-- A session's host changes the state of an input. It checks the caller owns the session and the
-- request comes from the computer that runs it, so the route needs no session lookup of its own.
-- A host may mark a stop or a decision consumed, but never a message: the transcript does that.
create or replace function host_transition_session_input(
  p_input_id uuid,
  p_session_id uuid,
  p_workspace_id uuid,
  p_owner_user_id uuid,
  p_host_machine_id text,
  p_from text[],
  p_to text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_host text;
  v_kind text;
begin
  select owner_user_id, host_machine_id into v_owner, v_host
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_owner is distinct from p_owner_user_id then
    raise exception 'not_session_owner';
  end if;
  if v_host is distinct from p_host_machine_id then
    raise exception 'foreign_host';
  end if;

  if p_to = 'consumed' then
    select kind into v_kind from session_inputs where id = p_input_id and session_id = p_session_id;
    if v_kind is null or v_kind = 'message' then
      raise exception 'invalid_state';
    end if;
  end if;

  return transition_session_input(p_input_id, p_session_id, p_from, p_to, p_reason, null);
end;
$$;

revoke all on function host_transition_session_input(uuid, uuid, uuid, uuid, text, text[], text, text) from public;
grant execute on function host_transition_session_input(uuid, uuid, uuid, uuid, text, text[], text, text) to service_role;
