-- Projection of an embedded agent (Home) into the session transcript, and its live text.

-- Appends an embedded agent's events (Home) to its session and marks the outbox rows they came from as projected, in one
-- transaction, so a crash can neither lose a projected event nor project one twice.
-- Seq comes from the session's counter, so it has no gaps. A duplicate source_id is skipped and uses no seq.
-- open_approval_count goes up for a new permission_request and down for a new permission_resolved, as for a host's events.
-- A user_message with payload.input_id also settles that input: consumed, at that seq. This is what ties a person's message
-- to its place in the transcript.
-- Only a backend-target session takes these; a host-run session's events come from its host (append_session_events).
-- p_outbox_keys are the embedded_agent_state outbox keys these events came from.
create or replace function append_backend_session_events(
  p_session_id uuid,
  p_workspace_id uuid,
  p_events jsonb, -- array of {source_id, kind, payload}
  p_outbox_keys text[]
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
  v_input uuid;
begin
  select * into v_session
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_session.execution_target <> 'backend' then
    raise exception 'foreign_host';
  end if;
  if v_session.status = 'ended' then
    raise exception 'session_ended';
  end if;

  v_seq := v_session.last_seq;
  perform set_config('draft.skip_event_signal', 'on', true);

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
      elsif v_event->>'kind' = 'user_message' and v_event->'payload'->>'input_id' is not null then
        begin
          v_input := (v_event->'payload'->>'input_id')::uuid;
          update session_inputs
          set state = 'consumed', consumed_seq = v_seq, reason = null, updated_at = now()
          where id = v_input and session_id = p_session_id and kind = 'message'
            and state in ('queued', 'delivering', 'uncertain');
        exception when invalid_text_representation then
          null;
        end;
      end if;
    end if;
  end loop;

  update embedded_agent_state
  set projected_at = now(), updated_at = now()
  where session_id = p_session_id and kind = 'outbox' and key = any(p_outbox_keys) and projected_at is null;

  if v_inserted > 0 then
    update sessions
    set last_seq = v_seq,
        last_event_at = now(),
        last_seen = now(),
        status = 'live',
        open_approval_count = greatest(0, open_approval_count + v_approvals)
    where id = p_session_id;

    perform broadcast_signal('signals:session:' || p_session_id, 'events', jsonb_build_object('seq', v_seq));
    perform broadcast_signal('signals:workspace:' || p_workspace_id, 'sessions');
  end if;

  perform set_config('draft.skip_event_signal', 'off', true);

  return jsonb_build_object('last_seq', v_seq, 'inserted', v_inserted);
end;
$$;

revoke all on function append_backend_session_events(uuid, uuid, jsonb, text[]) from public;
grant execute on function append_backend_session_events(uuid, uuid, jsonb, text[]) to service_role;

-- Sends a piece of the reply an embedded agent (Home) is writing, on "live:session:<id>". Nothing on it is stored, and a
-- piece is provisional: committed events are the record. Who receives it follows the session's row security, so a Home
-- reaches only its owner. A failed send never fails the caller.
create or replace function broadcast_live_text(p_session_id uuid, p_chunk jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from sessions where id = p_session_id and execution_target = 'backend') then
    return;
  end if;
  perform broadcast_signal('live:session:' || p_session_id, 'text', p_chunk);
end;
$$;

revoke all on function broadcast_live_text(uuid, jsonb) from public, anon, authenticated;
grant execute on function broadcast_live_text(uuid, jsonb) to service_role;
