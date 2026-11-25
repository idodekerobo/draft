-- Allocates the sequence number and inserts in one call, holding the workspace lock until the transaction ends.
create or replace function append_workspace_event(
  p_workspace_id uuid,
  p_event_type text,
  p_summary text,
  p_agent_run_id uuid default null,
  p_connection_id uuid default null,
  p_context_version_id uuid default null,
  p_payload_json jsonb default '{}',
  p_visibility text default 'shared',
  p_audience_person_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sequence bigint;
begin
  v_sequence := next_workspace_event_sequence(p_workspace_id);
  insert into workspace_events (
    workspace_id, sequence_number, event_type, agent_run_id, connection_id, context_version_id,
    summary, payload_json, occurred_at, visibility, audience_person_id
  ) values (
    p_workspace_id, v_sequence, p_event_type, p_agent_run_id, p_connection_id, p_context_version_id,
    p_summary, coalesce(p_payload_json, '{}'), now(), p_visibility, p_audience_person_id
  );
  return v_sequence;
end;
$$;

revoke all on function append_workspace_event(uuid, text, text, uuid, uuid, uuid, jsonb, text, uuid) from public;
grant execute on function append_workspace_event(uuid, text, text, uuid, uuid, uuid, jsonb, text, uuid) to service_role;
