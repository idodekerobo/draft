-- Fewer round trips for a send: create_session_input fills the author's name, and a host changes an
-- input's state through one function that also checks ownership.

create or replace function create_session_input(
  p_session_id uuid,
  p_workspace_id uuid,
  p_author_user_id uuid,
  p_author_name text,
  p_kind text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_type text;
  v_row session_inputs%rowtype;
  v_name text;
begin
  select status, session_type into v_status, v_type
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for share;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_type = 'routine' then
    raise exception 'routine_read_only';
  end if;
  if v_status = 'ended' then
    raise exception 'session_ended';
  end if;
  if (select count(*) from session_inputs
      where session_id = p_session_id and state = 'queued') >= 20 then
    raise exception 'queue_full';
  end if;

  if p_author_name is null then
    select coalesce(display_name, email) into v_name from users where id = p_author_user_id;
  end if;

  insert into session_inputs (session_id, workspace_id, author_user_id, author_name, kind, payload)
  values (p_session_id, p_workspace_id, p_author_user_id, coalesce(p_author_name, v_name, 'A teammate'), p_kind, coalesce(p_payload, '{}'::jsonb))
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

revoke all on function create_session_input(uuid, uuid, uuid, text, text, jsonb) from public;
grant execute on function create_session_input(uuid, uuid, uuid, text, text, jsonb) to service_role;

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
