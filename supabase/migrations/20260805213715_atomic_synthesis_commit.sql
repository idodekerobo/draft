-- Locks the run and workspace rows, re-verifies the base version is still
-- current, and only then writes the version/pointer/event/run-status changes
-- together. Trusts an already-computed content_hash rather than re-deriving
-- it in SQL; that logic stays in TypeScript (context-version-files.ts).
create or replace function commit_synthesis_run(
  p_run_id uuid,
  p_outcome text,
  p_summary text,
  p_documents_json jsonb,
  p_content_hash text,
  p_needs_input_json jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run synthesis_runs%rowtype;
  v_workspace_id uuid;
  v_current_version_id uuid;
  v_base_version_number bigint;
  v_new_version_id uuid;
  v_new_version_number bigint;
  v_next_sequence bigint;
  v_now timestamptz := now();
begin
  if p_outcome not in ('changed', 'no_change') then
    raise exception 'commit_synthesis_run: invalid outcome %', p_outcome;
  end if;

  select * into v_run
  from synthesis_runs
  where id = p_run_id
  for update;

  if not found then
    raise exception 'commit_synthesis_run: run % not found', p_run_id;
  end if;

  if v_run.status <> 'running' then
    raise exception 'commit_synthesis_run: run % has status %, expected running',
      p_run_id, v_run.status;
  end if;

  v_workspace_id := v_run.workspace_id;

  select current_context_version_id into v_current_version_id
  from workspaces
  where id = v_workspace_id
  for update;

  -- If the workspace's current pointer has moved since this run started,
  -- someone else committed first -- writing on top of a stale base would
  -- silently discard that commit.
  if v_current_version_id is distinct from v_run.base_context_version_id then
    update synthesis_runs
    set status = 'stale',
        outcome = 'stale',
        result_summary = format(
          'base version %s is no longer the workspace''s current version ' ||
          '(now %s); another commit landed while this run was in flight.',
          v_run.base_context_version_id, v_current_version_id
        ),
        completed_at = v_now
    where id = p_run_id;

    return jsonb_build_object('status', 'stale', 'new_version_id', null);
  end if;

  if p_outcome = 'changed' then
    select version_number into v_base_version_number
    from workspace_context_versions
    where id = v_run.base_context_version_id;

    v_new_version_number := v_base_version_number + 1;

    insert into workspace_context_versions (
      workspace_id, version_number, previous_version_id, documents_json,
      content_hash, creation_reason, synthesis_run_id, summary
    ) values (
      v_workspace_id, v_new_version_number, v_run.base_context_version_id,
      p_documents_json, p_content_hash, 'synthesis', p_run_id, p_summary
    )
    returning id into v_new_version_id;

    update workspaces
    set current_context_version_id = v_new_version_id
    where id = v_workspace_id;

    -- Allocated under the workspace row lock taken above, so no gap or
    -- collision can occur for a concurrent synthesis commit on this
    -- workspace.
    select coalesce(max(sequence_number), 0) + 1 into v_next_sequence
    from workspace_events
    where workspace_id = v_workspace_id;

    insert into workspace_events (
      workspace_id, sequence_number, event_type, synthesis_run_id,
      context_version_id, summary, occurred_at
    ) values (
      v_workspace_id, v_next_sequence, 'context_updated', p_run_id,
      v_new_version_id, p_summary, v_now
    );

    update synthesis_runs
    set status = 'succeeded',
        outcome = 'changed',
        result_summary = p_summary,
        result_hash = p_content_hash,
        needs_input_json = p_needs_input_json,
        completed_at = v_now
    where id = p_run_id;

    return jsonb_build_object('status', 'committed', 'new_version_id', v_new_version_id);
  end if;

  -- p_outcome = 'no_change'
  select coalesce(max(sequence_number), 0) + 1 into v_next_sequence
  from workspace_events
  where workspace_id = v_workspace_id;

  insert into workspace_events (
    workspace_id, sequence_number, event_type, synthesis_run_id,
    context_version_id, summary, occurred_at
  ) values (
    v_workspace_id, v_next_sequence, 'no_change', p_run_id,
    null, p_summary, v_now
  );

  update synthesis_runs
  set status = 'succeeded',
      outcome = 'no_change',
      result_summary = p_summary,
      needs_input_json = p_needs_input_json,
      completed_at = v_now
  where id = p_run_id;

  return jsonb_build_object('status', 'committed', 'new_version_id', null);
end;
$$;

revoke all on function commit_synthesis_run(uuid, text, text, jsonb, text, jsonb) from public;
grant execute on function commit_synthesis_run(uuid, text, text, jsonb, text, jsonb) to service_role;
