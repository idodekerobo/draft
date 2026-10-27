-- Adds an input to a session's queue. The author is the caller's user id and
-- display name, taken by the backend from the JWT. An ended session takes no input.
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
  v_row session_inputs%rowtype;
begin
  select status into v_status
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for share;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_status = 'ended' then
    raise exception 'session_ended';
  end if;
  if (select count(*) from session_inputs
      where session_id = p_session_id and state = 'queued') >= 20 then
    raise exception 'queue_full';
  end if;

  insert into session_inputs (session_id, workspace_id, author_user_id, author_name, kind, payload)
  values (p_session_id, p_workspace_id, p_author_user_id, p_author_name, p_kind, coalesce(p_payload, '{}'::jsonb))
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

revoke all on function create_session_input(uuid, uuid, uuid, text, text, jsonb) from public;
grant execute on function create_session_input(uuid, uuid, uuid, text, text, jsonb) to service_role;
