-- Commits the local half of a Linear webhook replacement. The caller creates
-- the upstream webhook first and compensates by deleting it if this function
-- raises linear_connection_conflict. The workspace lock covers first connect
-- (where no provider row exists yet); reconnects additionally compare the
-- source_connections.updated_at value observed before the network call.
create or replace function commit_linear_connection_swap(
  p_workspace_id uuid,
  p_expected_updated_at timestamptz,
  p_connection_key text,
  p_encrypted_payload bytea,
  p_encryption_key_version text,
  p_linear_webhook_id text,
  p_connected_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection source_connections%rowtype;
  v_credential_id uuid;
  v_prior_webhook_id text;
begin
  -- A provider row cannot be locked before the first connection exists, so
  -- serialize creation by locking its workspace. This also makes the lookup
  -- and expected-version comparison one atomic decision.
  perform 1
  from workspaces
  where id = p_workspace_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'linear_connection_conflict';
  end if;

  select * into v_connection
  from source_connections
  where workspace_id = p_workspace_id
    and provider = 'linear'
  order by created_at asc, id asc
  limit 1
  for update;

  if found then
    if p_expected_updated_at is null
       or v_connection.updated_at is distinct from p_expected_updated_at then
      raise exception using
        errcode = 'P0001',
        message = 'linear_connection_conflict';
    end if;

    v_prior_webhook_id := v_connection.config_json ->> 'linear_webhook_id';
    v_credential_id := v_connection.credential_id;

    if v_credential_id is null then
      insert into credentials (
        workspace_id, provider, encrypted_payload, encryption_key_version, status
      ) values (
        p_workspace_id, 'linear', p_encrypted_payload,
        p_encryption_key_version, 'active'
      )
      returning id into v_credential_id;
    else
      update credentials
      set provider = 'linear',
          encrypted_payload = p_encrypted_payload,
          encryption_key_version = p_encryption_key_version,
          status = 'active'
      where id = v_credential_id
        and workspace_id = p_workspace_id;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'linear_connection_conflict';
      end if;
    end if;

    update source_connections
    set connection_key = p_connection_key,
        credential_id = v_credential_id,
        config_json = coalesce(config_json, '{}'::jsonb)
          || jsonb_build_object('linear_webhook_id', p_linear_webhook_id),
        status = 'active',
        connected_by_user_id = coalesce(p_connected_by_user_id, connected_by_user_id),
        last_error_at = null
    where id = v_connection.id
      and workspace_id = p_workspace_id
    returning * into v_connection;
  else
    if p_expected_updated_at is not null then
      raise exception using
        errcode = 'P0001',
        message = 'linear_connection_conflict';
    end if;

    insert into credentials (
      workspace_id, provider, encrypted_payload, encryption_key_version, status
    ) values (
      p_workspace_id, 'linear', p_encrypted_payload,
      p_encryption_key_version, 'active'
    )
    returning id into v_credential_id;

    insert into source_connections (
      workspace_id, provider, connection_key, status, credential_id,
      config_json, connected_by_user_id, last_error_at
    ) values (
      p_workspace_id, 'linear', p_connection_key, 'active', v_credential_id,
      jsonb_build_object('linear_webhook_id', p_linear_webhook_id),
      p_connected_by_user_id, null
    )
    returning * into v_connection;
  end if;

  return jsonb_build_object(
    'connection_id', v_connection.id,
    'credential_id', v_credential_id,
    'prior_webhook_id', v_prior_webhook_id,
    'updated_at', v_connection.updated_at
  );
end;
$$;

revoke all on function commit_linear_connection_swap(
  uuid, timestamptz, text, bytea, text, text, uuid
) from public;
grant execute on function commit_linear_connection_swap(
  uuid, timestamptz, text, bytea, text, text, uuid
) to service_role;
