-- Claims up to p_limit inbox events: pending, or claimed with an expired lease.
-- Events whose lease expired after 3 attempts are marked dead first.
create or replace function claim_agent_events(
  p_limit int,
  p_lease_seconds int
)
returns setof agent_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  update agent_events
  set status = 'dead',
      failure_code = coalesce(failure_code, 'lease_expired'),
      updated_at = now()
  where status = 'claimed'
    and lease_until < now()
    and attempts >= 3;

  select array_agg(id) into v_ids
  from (
    select id
    from agent_events
    where status = 'pending'
       or (status = 'claimed' and lease_until < now())
    order by created_at asc
    limit p_limit
    for update skip locked
  ) eligible;

  if v_ids is null then
    return;
  end if;

  return query
    update agent_events
    set status = 'claimed',
        lease_until = now() + make_interval(secs => p_lease_seconds),
        attempts = attempts + 1,
        updated_at = now()
    where id = any(v_ids)
    returning *;
end;
$$;

revoke all on function claim_agent_events(int, int) from public;
grant execute on function claim_agent_events(int, int) to service_role;
