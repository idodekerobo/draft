-- Ends the lease on a credential only if p_run_id still holds it, so a late release never frees
-- another run's lease. Returns true when it released one.
create or replace function release_credential_lease(
  p_credential_id uuid,
  p_run_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update credentials
  set lease_run_id = null,
      lease_expires_at = null
  where id = p_credential_id
    and lease_run_id = p_run_id;

  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function release_credential_lease(uuid, uuid) from public;
grant execute on function release_credential_lease(uuid, uuid) to service_role;
