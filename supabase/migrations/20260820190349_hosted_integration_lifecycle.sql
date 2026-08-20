-- Hosted integration lifecycle correctness: singleton GitHub ownership,
-- active-gated ingestion writes, atomic disconnect, and compensated Linear
-- credential/webhook swaps. No data backfill is required before pilot launch.

create unique index source_connections_one_live_github_per_workspace
  on source_connections (workspace_id)
  where provider = 'github' and status <> 'revoked';

create or replace function upsert_source_item(
  p_workspace_id uuid,
  p_source_connection_id uuid,
  p_item_type text,
  p_external_id text,
  p_external_version text,
  p_occurred_at timestamptz,
  p_content_markdown text,
  p_content_hash text,
  p_metadata_json jsonb default '{}'::jsonb,
  p_sanitized_raw_json jsonb default null,
  p_lifecycle_status text default 'ready'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_status text;
  v_existing_hash text;
  v_prior_ids uuid[];
  v_supersede_id uuid;
  v_item_id uuid;
  v_changed boolean;
  v_now timestamptz := now();
begin
  select status into v_connection_status
  from source_connections
  where id = p_source_connection_id
    and workspace_id = p_workspace_id
  for update;

  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using
      errcode = 'P0001',
      message = 'connection_inactive';
  end if;

  select content_hash into v_existing_hash
  from source_items
  where source_connection_id = p_source_connection_id
    and external_id = p_external_id
    and external_version = p_external_version
  for update;

  v_changed := v_existing_hash is distinct from p_content_hash;

  with locked as (
    select id, normalized_at, created_at
    from source_items
    where source_connection_id = p_source_connection_id
      and external_id = p_external_id
      and lifecycle_status = 'ready'
      and external_version <> p_external_version
    for update
  )
  select array_agg(id order by normalized_at desc nulls last, created_at desc)
    into v_prior_ids
  from locked;

  v_supersede_id := v_prior_ids[1];

  insert into source_items (
    workspace_id, source_connection_id, item_type, external_id,
    external_version, lifecycle_status, occurred_at, normalized_at,
    content_markdown, content_hash, metadata_json, sanitized_raw_json,
    supersedes_source_item_id
  ) values (
    p_workspace_id, p_source_connection_id, p_item_type, p_external_id,
    p_external_version, p_lifecycle_status, p_occurred_at, v_now,
    p_content_markdown, p_content_hash, p_metadata_json, p_sanitized_raw_json,
    v_supersede_id
  )
  on conflict (source_connection_id, external_id, external_version)
  do update set
    item_type = excluded.item_type,
    lifecycle_status = excluded.lifecycle_status,
    occurred_at = excluded.occurred_at,
    normalized_at = excluded.normalized_at,
    content_markdown = excluded.content_markdown,
    content_hash = excluded.content_hash,
    metadata_json = excluded.metadata_json,
    sanitized_raw_json = excluded.sanitized_raw_json,
    supersedes_source_item_id =
      coalesce(source_items.supersedes_source_item_id, excluded.supersedes_source_item_id)
  returning id into v_item_id;

  if v_prior_ids is not null then
    update source_items
    set lifecycle_status = 'superseded'
    where id = any(v_prior_ids);
  end if;

  return jsonb_build_object(
    'item_id', v_item_id,
    'changed', v_changed,
    'superseded_item_ids', coalesce(to_jsonb(v_prior_ids), '[]'::jsonb)
  );
end;
$$;

revoke all on function upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text
) from public;
grant execute on function upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text
) to service_role;

create or replace function upsert_slack_message_if_connection_active(
  p_workspace_id uuid,
  p_source_connection_id uuid,
  p_channel_id text,
  p_channel_name_snapshot text,
  p_message_ts text,
  p_message_version text,
  p_thread_ts text,
  p_parent_user_id text,
  p_slack_user_id text,
  p_user_name_snapshot text,
  p_text text,
  p_subtype text,
  p_is_deleted boolean,
  p_edited_at timestamptz,
  p_deleted_at timestamptz,
  p_blocks_json jsonb,
  p_files_json jsonb,
  p_reactions_json jsonb,
  p_provider_metadata_json jsonb,
  p_captured_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_status text;
  v_message_id uuid;
begin
  select status into v_connection_status
  from source_connections
  where id = p_source_connection_id
    and workspace_id = p_workspace_id
    and provider = 'slack'
  for update;

  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using
      errcode = 'P0001',
      message = 'connection_inactive';
  end if;

  insert into slack_messages (
    workspace_id, source_connection_id, channel_id, channel_name_snapshot,
    message_ts, message_version, thread_ts, parent_user_id, slack_user_id,
    user_name_snapshot, text, subtype, is_deleted, edited_at, deleted_at,
    blocks_json, files_json, reactions_json, provider_metadata_json, captured_at
  ) values (
    p_workspace_id, p_source_connection_id, p_channel_id,
    p_channel_name_snapshot, p_message_ts, p_message_version, p_thread_ts,
    p_parent_user_id, p_slack_user_id, p_user_name_snapshot, p_text, p_subtype,
    p_is_deleted, p_edited_at, p_deleted_at, coalesce(p_blocks_json, '[]'::jsonb),
    coalesce(p_files_json, '[]'::jsonb), coalesce(p_reactions_json, '[]'::jsonb),
    coalesce(p_provider_metadata_json, '{}'::jsonb), p_captured_at
  )
  on conflict (source_connection_id, channel_id, message_ts, message_version)
  do update set
    channel_name_snapshot = excluded.channel_name_snapshot,
    thread_ts = excluded.thread_ts,
    parent_user_id = excluded.parent_user_id,
    slack_user_id = excluded.slack_user_id,
    user_name_snapshot = excluded.user_name_snapshot,
    text = excluded.text,
    subtype = excluded.subtype,
    is_deleted = excluded.is_deleted,
    edited_at = excluded.edited_at,
    deleted_at = excluded.deleted_at,
    blocks_json = excluded.blocks_json,
    files_json = excluded.files_json,
    reactions_json = excluded.reactions_json,
    provider_metadata_json = excluded.provider_metadata_json,
    captured_at = excluded.captured_at
  returning id into v_message_id;

  return jsonb_build_object('message_id', v_message_id);
end;
$$;

revoke all on function upsert_slack_message_if_connection_active(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text,
  boolean, timestamptz, timestamptz, jsonb, jsonb, jsonb, jsonb, timestamptz
) from public;
grant execute on function upsert_slack_message_if_connection_active(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text,
  boolean, timestamptz, timestamptz, jsonb, jsonb, jsonb, jsonb, timestamptz
) to service_role;

create or replace function disconnect_source_connection(
  p_workspace_id uuid,
  p_provider text
)
returns table(connection_id uuid, transitioned boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_id uuid;
begin
  select sc.id into v_connection_id
  from source_connections sc
  where sc.workspace_id = p_workspace_id
    and sc.provider = p_provider
    and sc.status <> 'revoked'
  order by sc.updated_at desc, sc.id desc
  limit 1
  for update;

  if not found then
    return query select null::uuid, false;
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

  return query select v_connection_id, true;
end;
$$;

revoke all on function disconnect_source_connection(uuid, text) from public;
grant execute on function disconnect_source_connection(uuid, text) to service_role;

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
