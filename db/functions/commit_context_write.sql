-- Writes one new context version if the workspace's current version is still
-- the one the caller read. The caller (TypeScript) has already checked each
-- changed document against the current content and computed the hash, so a
-- 'stale' answer only means another write landed first: read again and retry.
-- A synthesis run writes through here too. Its versions carry the reason 'synthesis'
-- and each adds a context_updated event tied to the run (agent_run_id), like any agent's write.
create or replace function commit_context_write(
  p_workspace_id uuid,
  p_expected_version_id uuid,
  p_documents_json jsonb,
  p_content_hash text,
  p_creation_reason text,
  p_summary text,
  p_agent_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current_version_id uuid;
  v_previous_number bigint;
  v_new_version_id uuid;
  v_new_version_number bigint;
  v_next_sequence bigint;
  v_now timestamptz := now();
begin
  if p_creation_reason not in ('seed', 'memory_provision', 'agent_write', 'synthesis') then
    raise exception 'commit_context_write: invalid creation reason %', p_creation_reason;
  end if;

  select current_context_version_id into v_current_version_id
  from workspaces
  where id = p_workspace_id
  for update;

  if not found then
    raise exception 'commit_context_write: workspace % not found', p_workspace_id;
  end if;

  if v_current_version_id is distinct from p_expected_version_id then
    return jsonb_build_object('status', 'stale', 'current_version_id', v_current_version_id);
  end if;

  -- Under the workspace row lock, so two writers cannot pick the same number.
  select coalesce(max(version_number), 0) into v_previous_number
  from workspace_context_versions
  where workspace_id = p_workspace_id;
  v_new_version_number := v_previous_number + 1;

  insert into workspace_context_versions (
    workspace_id, version_number, previous_version_id, documents_json,
    content_hash, creation_reason, summary, agent_run_id
  ) values (
    p_workspace_id, v_new_version_number, v_current_version_id, p_documents_json,
    p_content_hash, p_creation_reason, p_summary, p_agent_run_id
  )
  returning id into v_new_version_id;

  update workspaces
  set current_context_version_id = v_new_version_id
  where id = p_workspace_id;

  -- An agent's or a synthesis run's write is news. Seeding and memory stubs stay out of the feed.
  if p_creation_reason in ('agent_write', 'synthesis') then
    select coalesce(max(sequence_number), 0) + 1 into v_next_sequence
    from workspace_events
    where workspace_id = p_workspace_id;

    insert into workspace_events (
      workspace_id, sequence_number, event_type, agent_run_id, context_version_id, summary, payload_json, occurred_at
    ) values (
      p_workspace_id, v_next_sequence, 'context_updated',
      p_agent_run_id,
      v_new_version_id, p_summary,
      jsonb_build_object('agent_run_id', p_agent_run_id), v_now
    );
  end if;

  return jsonb_build_object(
    'status', 'committed',
    'new_version_id', v_new_version_id,
    'version_number', v_new_version_number
  );
end;
$$;

revoke all on function commit_context_write(uuid, uuid, jsonb, text, text, text, uuid) from public;
grant execute on function commit_context_write(uuid, uuid, jsonb, text, text, text, uuid) to service_role;
