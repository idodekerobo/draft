-- Cloud session wake. A sleeping session is claimed by one caller, and a sleeping session refuses appends,
-- so a late write from an old host cannot set it live with no run.

-- Moves a sleeping cloud session to starting, so a wake can start its next run.
-- Returns true for the one caller that moved it, so two sends to a sleeping session start one run.
-- It also sets last_seen: the stale-session sweep would mark the new host host_offline before its first heartbeat.
create or replace function claim_cloud_session_wake(p_session_id uuid, p_workspace_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update sessions
  set status = 'starting',
      last_seen = now()
  where id = p_session_id and workspace_id = p_workspace_id
    and runtime = 'cloud' and status = 'sleeping' and deleted_at is null;

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function claim_cloud_session_wake(uuid, uuid) from public;
grant execute on function claim_cloud_session_wake(uuid, uuid) to service_role;

-- Session status:
--   starting -> live -> ended
--   starting/live --no heartbeat for 60 s--> host_offline --same host heartbeat--> live
--   starting/live/host_offline --the cloud host sleeps--> sleeping --a wake--> starting
-- Idle is not stored. Writes for an ended or sleeping session are rejected. A sleeping session has no
-- run, so a late append from an old host must not set it live.
--
-- Appends a batch of events in order. Seq comes from the session's counter, so
-- it has no gaps. A duplicate source_id is skipped and does not use a seq.
-- open_approval_count goes up for a new permission_request and down for a new permission_resolved.
-- Each row is its own insert statement, so the statement trigger would signal once per row.
-- The function turns the trigger off for this transaction and sends one signal for the batch.
create or replace function append_session_events(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_id text,
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
  if v_session.status = 'sleeping' then
    raise exception 'session_sleeping';
  end if;
  if v_session.host_id is distinct from p_host_id then
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
