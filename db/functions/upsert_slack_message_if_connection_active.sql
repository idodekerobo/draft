-- Atomically verifies that Slack ingestion is still allowed and captures one
-- message. The connection row lock serializes this final write with
-- disconnect_source_connection; source_item_id is deliberately not an input,
-- so a repeated capture cannot clear a later materialization link.
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
