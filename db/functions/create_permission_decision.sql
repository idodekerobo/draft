-- Records the first decision for an open permission request.
-- Returns {outcome: 'created', input}, or {outcome: 'already_decided', by_name, decision},
-- or {outcome: 'request_closed', reason} when the request ended some other way.
create or replace function create_permission_decision(
  p_session_id uuid,
  p_workspace_id uuid,
  p_author_user_id uuid,
  p_author_name text,
  p_request_id text,
  p_decision text
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
          jsonb_build_object('requestId', p_request_id, 'decision', p_decision))
  returning * into v_row;

  return jsonb_build_object('outcome', 'created', 'input', to_jsonb(v_row));
end;
$$;

revoke all on function create_permission_decision(uuid, uuid, uuid, text, text, text) from public;
grant execute on function create_permission_decision(uuid, uuid, uuid, text, text, text) to service_role;
