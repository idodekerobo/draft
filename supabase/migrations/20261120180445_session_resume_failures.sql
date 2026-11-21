alter table sessions add column resume_request_id uuid, add column last_failure jsonb;

-- Reports are retried by hosts. The failure UUID makes error and history writes idempotent.
-- Failure notes may be added after ending, without append_session_events reviving the session.
create or replace function report_session_failure(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_id text,
  p_failure jsonb,
  p_diagnostics jsonb,
  p_terminal boolean,
  p_expected_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session sessions%rowtype;
  v_count integer;
  v_current boolean;
  v_applied boolean := false;
begin
  select * into v_session from sessions
  where id = p_session_id and workspace_id = p_workspace_id and deleted_at is null
  for update;
  if not found then raise exception 'session_not_found'; end if;
  if v_session.host_id is distinct from p_host_id then raise exception 'foreign_host'; end if;

  insert into errors (id, workspace_id, session_id, operation, message, detail_json)
  values ((p_failure->>'id')::uuid, p_workspace_id, p_session_id, 'session',
    p_failure->>'message', p_diagnostics || jsonb_build_object(
      'code', p_failure->>'code', 'request_id', p_failure->>'requestId',
      'occurred_at', p_failure->>'at'))
  on conflict (id) do nothing;
  get diagnostics v_count = row_count;
  if v_count = 0 then return jsonb_build_object('terminal_applied', false); end if;

  v_current := v_session.resume_request_id is not distinct from (p_failure->>'requestId')::uuid
    or (v_session.status = 'ended' and v_session.resume_request_id is not distinct from p_expected_request_id);
  if p_terminal then
    insert into session_events (session_id, workspace_id, seq, source_id, kind, payload)
    values (p_session_id, p_workspace_id, v_session.last_seq + 1,
      'failure:' || (p_failure->>'id'), 'session_note',
      jsonb_build_object('text', p_failure->>'message', 'failure', p_failure));
    update sessions set last_seq = last_seq + 1, last_event_at = now() where id = p_session_id;

    if v_current and coalesce(v_session.end_reason, '') not in ('cleared', 'deleted', 'ended_by_owner') then
      update sessions set last_failure = p_failure, status = 'ended',
        ended_at = coalesce(ended_at, now()), end_reason = p_failure->>'code', open_approval_count = 0
      where id = p_session_id;
      v_applied := true;
    end if;
    perform broadcast_signal('signals:workspace:' || p_workspace_id, 'sessions');
  end if;
  return jsonb_build_object('terminal_applied', v_applied);
end;
$$;

revoke all on function report_session_failure(uuid, uuid, text, jsonb, jsonb, boolean, uuid) from public;
grant execute on function report_session_failure(uuid, uuid, text, jsonb, jsonb, boolean, uuid) to service_role;
