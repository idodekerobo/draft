-- Live agent sessions, slice 4: permission approvals and Stop.

alter table sessions add column open_approval_count integer not null default 0;

alter table session_events drop constraint session_events_kind_check;
alter table session_events add constraint session_events_kind_check
  check (kind in ('user_message', 'assistant_text', 'tool_use', 'tool_result', 'thinking', 'session_note',
                  'permission_request', 'permission_resolved'));

-- One winning decision per request. A failed decision does not count.
create unique index session_inputs_one_decision_idx
  on session_inputs (session_id, (payload->>'requestId'))
  where kind = 'permission_decision' and state <> 'failed';

-- Session status:
--   starting -> live -> ended
--   starting/live --no heartbeat for 60 s--> host_offline --same host heartbeat--> live
-- Idle is not stored. Writes for an ended session are rejected.
--
-- Appends a batch of events in order. Seq comes from the session's counter, so
-- it has no gaps. A duplicate source_id is skipped and does not use a seq.
-- open_approval_count goes up for a new permission_request and down for a new permission_resolved.
create or replace function append_session_events(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_machine_id text,
  p_events jsonb -- array of {source_id, kind, payload}
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session sessions%rowtype;
  v_event jsonb;
  v_seq bigint;
  v_inserted integer := 0;
  v_count integer;
  v_approvals integer := 0;
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

  v_seq := v_session.last_seq;

  for v_event in select * from jsonb_array_elements(p_events) loop
    insert into session_events (session_id, workspace_id, seq, source_id, kind, payload)
    values (
      p_session_id, p_workspace_id, v_seq + 1,
      v_event->>'source_id', v_event->>'kind', coalesce(v_event->'payload', '{}'::jsonb)
    )
    on conflict (session_id, source_id) do nothing;

    get diagnostics v_count = row_count;
    if v_count > 0 then
      v_seq := v_seq + 1;
      v_inserted := v_inserted + 1;
      if v_event->>'kind' = 'permission_request' then
        v_approvals := v_approvals + 1;
      elsif v_event->>'kind' = 'permission_resolved' then
        v_approvals := v_approvals - 1;
      end if;
    end if;
  end loop;

  if v_inserted > 0 then
    update sessions
    set last_seq = v_seq,
        last_event_at = now(),
        status = 'live',
        open_approval_count = greatest(0, open_approval_count + v_approvals)
    where id = p_session_id;
  end if;

  return jsonb_build_object('last_seq', v_seq, 'inserted', v_inserted);
end;
$$;

revoke all on function append_session_events(uuid, uuid, text, jsonb) from public;
grant execute on function append_session_events(uuid, uuid, text, jsonb) to service_role;

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
