-- Widen scheduled_tasks.task_type to allow 'summarize_sessions', and add the
-- claim RPC the summarization worker uses to lease pending agent_sessions
-- rows (mirrors upsert_source_item.sql's SELECT ... FOR UPDATE SKIP LOCKED +
-- UPDATE ... RETURNING pattern; no new tracking table needed since the lease
-- state already lives on agent_sessions itself).

alter table scheduled_tasks
  drop constraint scheduled_tasks_task_type_check;

alter table scheduled_tasks
  add constraint scheduled_tasks_task_type_check
    check (task_type in ('ingest_source', 'synthesize_workspace', 'rebuild_projection', 'summarize_sessions'));

-- Claims up to p_limit sessions eligible for summarization: pending, or
-- leased with an expired lease (a worker crashed mid-run), or failed with
-- fewer than 3 attempts. Locks eligible rows with SKIP LOCKED so concurrent
-- callers never double-claim, then marks them leased with a fresh expiry.
create or replace function claim_pending_summary_sessions(
  p_workspace_id uuid,
  p_limit int,
  p_lease_seconds int
)
returns setof agent_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  select array_agg(id) into v_ids
  from (
    select id
    from agent_sessions
    where workspace_id = p_workspace_id
      and (
        summary_status = 'pending'
        or (summary_status = 'leased' and summary_lease_until < now())
        or (summary_status = 'failed' and summary_attempts < 3)
      )
    order by started_at asc
    limit p_limit
    for update skip locked
  ) eligible;

  if v_ids is null then
    return;
  end if;

  return query
    update agent_sessions
    set summary_status = 'leased',
        summary_lease_until = now() + make_interval(secs => p_lease_seconds),
        summary_attempts = summary_attempts + 1
    where id = any(v_ids)
    returning *;
end;
$$;

revoke all on function claim_pending_summary_sessions(uuid, int, int) from public;
grant execute on function claim_pending_summary_sessions(uuid, int, int) to service_role;
