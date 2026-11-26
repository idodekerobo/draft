-- Saves the workspace's login for a harness provider in one statement, so two first saves at once
-- leave one row. A re-save replaces the secret, reactivates the row, clears the lease and makes the
-- saver the owner. The conflict target must match credentials_one_harness_login_idx.
create or replace function save_harness_credential(
  p_workspace_id uuid,
  p_provider text,
  p_encrypted_payload bytea,
  p_key_version text,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_provider not in ('claude_code', 'codex_chatgpt_auth') then
    raise exception 'unsupported harness provider %', p_provider;
  end if;

  insert into credentials (workspace_id, provider, encrypted_payload, encryption_key_version, status, created_by_user_id)
  values (p_workspace_id, p_provider, p_encrypted_payload, p_key_version, 'active', p_user_id)
  on conflict (workspace_id, provider) where provider in ('claude_code', 'codex_chatgpt_auth')
  do update set
    encrypted_payload = excluded.encrypted_payload,
    encryption_key_version = excluded.encryption_key_version,
    status = 'active',
    lease_run_id = null,
    lease_expires_at = null,
    created_by_user_id = excluded.created_by_user_id,
    updated_at = now()
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function save_harness_credential(uuid, text, bytea, text, uuid) from public;
grant execute on function save_harness_credential(uuid, text, bytea, text, uuid) to service_role;
