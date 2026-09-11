-- Rotates a Granola credential generation. Simpler than the Fireflies
-- equivalent: Granola's webhook endpoint is a separate object keyed by its
-- own id (stored inside the credential payload), not tied to the API key
-- value, so rotating the key never needs to touch or recreate the webhook.
create or replace function rotate_granola_connection_credential(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_encrypted_payload bytea,
  p_encryption_key_version text,
  p_connected_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection source_connections%rowtype;
  v_prior_credential_id uuid;
  v_new_credential_id uuid;
begin
  select * into v_connection
  from source_connections
  where id = p_connection_id
    and workspace_id = p_workspace_id
    and provider = 'granola'
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'granola_connection_conflict';
  end if;

  v_prior_credential_id := v_connection.credential_id;

  insert into credentials (
    workspace_id, provider, encrypted_payload, encryption_key_version, status
  ) values (
    p_workspace_id, 'granola', p_encrypted_payload,
    p_encryption_key_version, 'active'
  )
  returning id into v_new_credential_id;

  update source_connections
  set credential_id = v_new_credential_id,
      status = 'active',
      connected_by_user_id = coalesce(p_connected_by_user_id, connected_by_user_id),
      last_success_at = null,
      last_error_at = null
  where id = v_connection.id
    and workspace_id = p_workspace_id;

  if v_prior_credential_id is not null then
    update credentials
    set status = 'revoked'
    where id = v_prior_credential_id
      and workspace_id = p_workspace_id;
  end if;

  return jsonb_build_object(
    'connection_id', v_connection.id,
    'connection_key', v_connection.connection_key,
    'credential_id', v_new_credential_id
  );
end;
$$;

revoke all on function rotate_granola_connection_credential(
  uuid, uuid, bytea, text, uuid
) from public;
grant execute on function rotate_granola_connection_credential(
  uuid, uuid, bytea, text, uuid
) to service_role;
