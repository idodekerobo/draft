-- Cap summarization attempts at 3 for expired leases too. Previously only
-- 'failed' rows were capped, so a run that never reported per-session results
-- re-claimed the same sessions forever. Sessions that exhausted their attempts
-- on an expired lease are now marked 'skipped' before claiming.
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
  update agent_sessions
  set summary_status = 'skipped',
      summary_last_error = coalesce(summary_last_error, 'exceeded_max_summary_attempts')
  where workspace_id = p_workspace_id
    and summary_status = 'leased'
    and summary_lease_until < now()
    and summary_attempts >= 3;

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
