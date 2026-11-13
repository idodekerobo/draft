-- One signal per appended batch. The append function inserts row by row, so the statement
-- trigger fired once per row. The function now skips the trigger and signals once itself.

-- New events: one signal per session in the statement, with the highest seq, and one per workspace.
-- append_session_events sends its own signal for a whole batch and sets draft.skip_event_signal to skip this.
create or replace function signal_session_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  if current_setting('draft.skip_event_signal', true) = 'on' then
    return null;
  end if;
  for r in select session_id, max(seq) as seq from new_rows group by session_id loop
    perform public.broadcast_signal('signals:session:' || r.session_id, 'events', jsonb_build_object('seq', r.seq));
  end loop;
  for r in select distinct workspace_id from new_rows loop
    perform public.broadcast_signal('signals:workspace:' || r.workspace_id, 'sessions');
  end loop;
  return null;
end;
$$;

-- Session status:
--   starting -> live -> ended
--   starting/live --no heartbeat for 60 s--> host_offline --same host heartbeat--> live
-- Idle is not stored. Writes for an ended session are rejected.
--
-- Appends a batch of events in order. Seq comes from the session's counter, so
-- it has no gaps. A duplicate source_id is skipped and does not use a seq.
-- open_approval_count goes up for a new permission_request and down for a new permission_resolved.
-- Each row is its own insert statement, so the statement trigger would signal once per row.
-- The function turns the trigger off for this transaction and sends one signal for the batch.
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
      end if;
    end if;
  end loop;

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

revoke all on function append_session_events(uuid, uuid, text, jsonb) from public;
grant execute on function append_session_events(uuid, uuid, text, jsonb) to service_role;
