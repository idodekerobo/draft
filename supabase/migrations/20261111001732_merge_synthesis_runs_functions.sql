-- Second step of merging synthesis_runs into agent_runs: the SQL functions read and write agent_runs.
-- A run the old backend started is in both tables, so finalize keeps the synthesis_runs copy in step.

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

-- Ends a synthesis run whose documents were already written through context.write.
-- The context versions and their events exist by now; this only records how the run
-- ended: status, outcome, summary, the hash of what the context became, and any
-- questions for people. A no_change run adds its no_change event here.
create or replace function finalize_synthesis_run(
  p_run_id uuid,
  p_outcome text,
  p_summary text,
  p_result_hash text,
  p_needs_input_json jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run agent_runs%rowtype;
  v_next_sequence bigint;
  v_now timestamptz := now();
begin
  if p_outcome not in ('changed', 'no_change') then
    raise exception 'finalize_synthesis_run: invalid outcome %', p_outcome;
  end if;

  select * into v_run
  from agent_runs
  where id = p_run_id and kind = 'synthesis'
  for update;

  if not found then
    raise exception 'finalize_synthesis_run: run % not found', p_run_id;
  end if;

  if v_run.status <> 'running' then
    raise exception 'finalize_synthesis_run: run % has status %, expected running',
      p_run_id, v_run.status;
  end if;

  if p_outcome = 'no_change' then
    -- Under the workspace row lock, so no gap or collision in the sequence.
    perform 1 from workspaces where id = v_run.workspace_id for update;

    select coalesce(max(sequence_number), 0) + 1 into v_next_sequence
    from workspace_events
    where workspace_id = v_run.workspace_id;

    insert into workspace_events (
      workspace_id, sequence_number, event_type, agent_run_id,
      context_version_id, summary, occurred_at
    ) values (
      v_run.workspace_id, v_next_sequence, 'no_change', p_run_id,
      null, p_summary, v_now
    );
  end if;

  update agent_runs
  set status = 'succeeded',
      outcome = p_outcome,
      summary = p_summary,
      result_hash = p_result_hash,
      needs_input_json = p_needs_input_json,
      completed_at = v_now
  where id = p_run_id;

  -- A run the old backend started is also in synthesis_runs. Keep that copy in step until it is dropped.
  update synthesis_runs
  set status = 'succeeded',
      outcome = p_outcome,
      result_summary = p_summary,
      result_hash = p_result_hash,
      needs_input_json = p_needs_input_json,
      completed_at = v_now
  where id = p_run_id;

  return jsonb_build_object('status', 'succeeded', 'outcome', p_outcome);
end;
$$;

revoke all on function finalize_synthesis_run(uuid, text, text, text, jsonb) from public;
grant execute on function finalize_synthesis_run(uuid, text, text, text, jsonb) to service_role;

create or replace function get_pending_synthesis_source_item_ids(
  p_workspace_id uuid,
  p_reprocess boolean default false
)
returns table (source_item_id uuid)
language sql
security definer
set search_path = public
stable
as $$
  select si.id
  from source_items si
  where si.workspace_id = p_workspace_id
    and si.lifecycle_status = 'active'
    and (
      p_reprocess
      or not exists (
        select 1
        from agent_run_source_items srsi
        join agent_runs sr
          on sr.id = srsi.agent_run_id
         and sr.workspace_id = srsi.workspace_id
        where srsi.workspace_id = si.workspace_id
          and srsi.source_item_id = si.id
          and srsi.source_item_version = si.external_version
          and srsi.content_hash = si.content_hash
          and sr.kind = 'synthesis'
          and sr.status = 'succeeded'
          and sr.outcome in ('changed', 'no_change')
      )
    )
  order by si.occurred_at asc, si.id asc;
$$;

revoke all on function get_pending_synthesis_source_item_ids(uuid, boolean) from public;
grant execute on function get_pending_synthesis_source_item_ids(uuid, boolean) to service_role;
