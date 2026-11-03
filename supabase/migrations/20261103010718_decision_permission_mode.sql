-- A plan approval can carry the mode to switch the session to.
-- The nine-argument function is dropped so a call resolves to the new one through defaults.
drop function if exists create_permission_decision(uuid, uuid, uuid, text, text, text, jsonb, text, text);

-- Records the first decision for an open permission request.
-- Returns {outcome: 'created', input}, or {outcome: 'already_decided', by_name, decision},
-- or {outcome: 'request_closed', reason} when the request ended some other way.
-- p_answers (object of string or string[]), p_message, p_scope and p_permission_mode ride along in the input payload.
-- p_permission_mode is the mode a plan approval switches the session to.
create or replace function create_permission_decision(
  p_session_id uuid,
  p_workspace_id uuid,
  p_author_user_id uuid,
  p_author_name text,
  p_request_id text,
  p_decision text,
  p_answers jsonb default null,
  p_message text default null,
  p_scope text default null,
  p_permission_mode text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_resolved session_events%rowtype;
  v_existing session_inputs%rowtype;
  v_row session_inputs%rowtype;
begin
  if p_decision not in ('allow', 'deny') then
    raise exception 'invalid_decision';
  end if;
  if p_answers is not null and (jsonb_typeof(p_answers) <> 'object' or length(p_answers::text) > 16000) then
    raise exception 'invalid_answers';
  end if;
  if p_message is not null and length(p_message) > 2000 then
    raise exception 'invalid_message';
  end if;
  if p_scope is not null and p_scope not in ('once', 'session') then
    raise exception 'invalid_scope';
  end if;
  if p_permission_mode is not null and p_permission_mode not in ('auto', 'default') then
    raise exception 'invalid_permission_mode';
  end if;

  select status into v_status
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_status = 'ended' then
    raise exception 'session_ended';
  end if;
  if not exists (
    select 1 from session_events
    where session_id = p_session_id and source_id = 'perm:' || p_request_id
  ) then
    raise exception 'request_not_found';
  end if;

  select * into v_resolved
  from session_events
  where session_id = p_session_id and source_id = 'permres:' || p_request_id;
  if found then
    if v_resolved.payload->>'reason' = 'decided' then
      return jsonb_build_object('outcome', 'already_decided',
        'by_name', v_resolved.payload->>'by_name', 'decision', v_resolved.payload->>'decision');
    end if;
    return jsonb_build_object('outcome', 'request_closed', 'reason', v_resolved.payload->>'reason');
  end if;

  select * into v_existing
  from session_inputs
  where session_id = p_session_id and kind = 'permission_decision'
    and payload->>'requestId' = p_request_id and state <> 'failed';
  if found then
    return jsonb_build_object('outcome', 'already_decided',
      'by_name', v_existing.author_name, 'decision', v_existing.payload->>'decision');
  end if;

  insert into session_inputs (session_id, workspace_id, author_user_id, author_name, kind, payload)
  values (p_session_id, p_workspace_id, p_author_user_id, p_author_name, 'permission_decision',
          jsonb_strip_nulls(jsonb_build_object(
            'requestId', p_request_id,
            'decision', p_decision,
            'answers', p_answers,
            'message', nullif(btrim(p_message), ''),
            'scope', p_scope,
            'permissionMode', p_permission_mode)))
  returning * into v_row;

  return jsonb_build_object('outcome', 'created', 'input', to_jsonb(v_row));
end;
$$;

revoke all on function create_permission_decision(uuid, uuid, uuid, text, text, text, jsonb, text, text, text) from public;
grant execute on function create_permission_decision(uuid, uuid, uuid, text, text, text, jsonb, text, text, text) to service_role;
