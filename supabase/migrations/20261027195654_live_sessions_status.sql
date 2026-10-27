-- Host heartbeat, offline sweep and session rotation.
alter table sessions
  add column last_seen timestamptz not null default now(),
  add column harness_version text,
  add column previous_session_id uuid references sessions(id) on delete set null;

create index sessions_unfinished_last_seen_idx on sessions (last_seen)
  where status in ('starting', 'live');

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
        last_seen = now(),
        status = 'live',
        open_approval_count = greatest(0, open_approval_count + v_approvals)
    where id = p_session_id;
  end if;

  return jsonb_build_object('last_seq', v_seq, 'inserted', v_inserted);
end;
$$;

revoke all on function append_session_events(uuid, uuid, text, jsonb) from public;
grant execute on function append_session_events(uuid, uuid, text, jsonb) to service_role;

-- Records that the host is alive. A host_offline session returns to live.
-- A session that is still starting stays starting. Writes for an ended session
-- or from another host are rejected.
create or replace function heartbeat_session(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_machine_id text,
  p_harness_version text default null
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
      harness_version = coalesce(p_harness_version, harness_version)
  where id = p_session_id;

  return v_status;
end;
$$;

revoke all on function heartbeat_session(uuid, uuid, text, text) from public;
grant execute on function heartbeat_session(uuid, uuid, text, text) to service_role;

-- Marks sessions whose host has not sent a heartbeat for p_stale_after as host_offline.
-- The scheduler tick calls it. The same host's next heartbeat or append sets the session back to live.
create or replace function sweep_stale_sessions(p_stale_after interval default interval '60 seconds')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update sessions
  set status = 'host_offline'
  where status in ('starting', 'live')
    and last_seen < now() - p_stale_after;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function sweep_stale_sessions(interval) from public;
grant execute on function sweep_stale_sessions(interval) to service_role;
