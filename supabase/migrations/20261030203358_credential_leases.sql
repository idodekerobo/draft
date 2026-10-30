-- A credential that cannot be shared by two runs at once (a Codex auth file rotates its refresh token)
-- is held by one run through a lease. The lease ends on release or when it expires, so a crashed run
-- cannot hold it for ever.
alter table credentials
  add column lease_run_id uuid,
  add column lease_expires_at timestamptz;

-- Takes the lease for p_run_id when no other run holds it. Returns false when another run does,
-- or when the credential is not active. The same run can take it again, which renews it.
create or replace function acquire_credential_lease(
  p_credential_id uuid,
  p_workspace_id uuid,
  p_run_id uuid,
  p_ttl interval
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
  set lease_run_id = p_run_id,
      lease_expires_at = now() + p_ttl
  where id = p_credential_id
    and workspace_id = p_workspace_id
    and status = 'active'
    and (lease_run_id is null or lease_run_id = p_run_id or lease_expires_at < now());

  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

-- Ends the lease only if p_run_id still holds it, so a late release never frees another run's lease.
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

revoke all on function acquire_credential_lease(uuid, uuid, uuid, interval) from public;
revoke all on function release_credential_lease(uuid, uuid) from public;
grant execute on function acquire_credential_lease(uuid, uuid, uuid, interval) to service_role;
grant execute on function release_credential_lease(uuid, uuid) to service_role;
