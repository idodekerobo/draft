-- Granola is the first provider that is multi-account AND singleton at once:
-- a personal API key connects one row per teammate (connected_by_user_id
-- not null), while a workspace API key connects at most one shared row
-- (connected_by_user_id null). Two separate partial unique indexes express
-- that split; provider = 'granola' already exists in the source_connections
-- provider check (foundation migration), so no enum change is needed.

create unique index source_connections_granola_personal_per_user
  on source_connections (workspace_id, provider, connected_by_user_id)
  where provider = 'granola' and connected_by_user_id is not null;

create unique index source_connections_granola_one_workspace_key
  on source_connections (workspace_id, provider)
  where provider = 'granola' and connected_by_user_id is null and status <> 'revoked';

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

-- Advances webhook readiness only for the credential generation that
-- authenticated the delivery, same generation-pinning as
-- mark_fireflies_webhook_success.
create or replace function mark_granola_webhook_success(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_credential_id uuid,
  p_succeeded_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update source_connections
  set last_success_at = p_succeeded_at
  where id = p_connection_id
    and workspace_id = p_workspace_id
    and provider = 'granola'
    and credential_id = p_credential_id
    and status in ('active', 'degraded');

  return found;
end;
$$;

revoke all on function mark_granola_webhook_success(
  uuid, uuid, uuid, timestamptz
) from public;
grant execute on function mark_granola_webhook_success(
  uuid, uuid, uuid, timestamptz
) to service_role;

-- disconnect_source_connection previously always picked the single most
-- recently updated non-revoked row for (workspace, provider) -- correct for
-- every existing provider (each has at most one row per caller, or exactly
-- one row total), but Granola can have BOTH a caller-owned personal row and
-- a separate null-owner workspace row live at once, and the route needs to
-- target one deliberately rather than "whichever changed last". Add an
-- optional p_account_kind filter; every existing caller omits it and keeps
-- today's exact behavior.
drop function if exists disconnect_source_connection(uuid, text, uuid);

create or replace function disconnect_source_connection(
  p_workspace_id uuid,
  p_provider text,
  p_connected_by_user_id uuid,
  p_account_kind text default null
)
returns table(connection_id uuid, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_id uuid;
  v_owner uuid;
begin
  select sc.id, sc.connected_by_user_id into v_connection_id, v_owner
  from source_connections sc
  where sc.workspace_id = p_workspace_id
    and sc.provider = p_provider
    and sc.status <> 'revoked'
    and (
      p_account_kind is null
      or (p_account_kind = 'personal' and sc.connected_by_user_id = p_connected_by_user_id)
      or (p_account_kind = 'workspace' and sc.connected_by_user_id is null)
    )
  order by sc.updated_at desc, sc.id desc
  limit 1
  for update;

  if not found then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;

  -- A null owner (older rows, or a provider that was never personally
  -- attributed) is unowned, not "owned by no one" -- anyone with workspace
  -- access may still disconnect it.
  if v_owner is not null and v_owner <> p_connected_by_user_id then
    return query select v_connection_id, 'not_owner'::text;
    return;
  end if;

  update source_connections
  set status = 'revoked'
  where id = v_connection_id
    and workspace_id = p_workspace_id;

  update scheduled_tasks
  set enabled = false
  where source_connection_id = v_connection_id
    and workspace_id = p_workspace_id
    and enabled;

  return query select v_connection_id, 'disconnected'::text;
end;
$$;

revoke all on function disconnect_source_connection(uuid, text, uuid, text) from public;
grant execute on function disconnect_source_connection(uuid, text, uuid, text) to service_role;
