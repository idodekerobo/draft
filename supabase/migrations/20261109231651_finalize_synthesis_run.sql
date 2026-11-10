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
  v_run synthesis_runs%rowtype;
  v_next_sequence bigint;
  v_now timestamptz := now();
begin
  if p_outcome not in ('changed', 'no_change') then
    raise exception 'finalize_synthesis_run: invalid outcome %', p_outcome;
  end if;

  select * into v_run
  from synthesis_runs
  where id = p_run_id
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
      workspace_id, sequence_number, event_type, synthesis_run_id,
      context_version_id, summary, occurred_at
    ) values (
      v_run.workspace_id, v_next_sequence, 'no_change', p_run_id,
      null, p_summary, v_now
    );
  end if;

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
