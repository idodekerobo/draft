export interface SlackMessageRow {
  id: string;
  workspace_id: string;
  source_connection_id: string;
  source_item_id: string | null;
  channel_id: string;
  channel_name_snapshot: string | null;
  message_ts: string;
  message_version: string;
  thread_ts: string | null;
  parent_user_id: string | null;
  slack_user_id: string | null;
  user_name_snapshot: string | null;
  text: string | null;
  subtype: string | null;
  is_deleted: boolean;
  edited_at: string | null;
  deleted_at: string | null;
  blocks_json: unknown[];
  files_json: SlackMessageFileRef[];
  reactions_json: unknown[];
  provider_metadata_json: Record<string, unknown>;
  captured_at: string;
  created_at: string;
  updated_at: string;
}

/** files_json entries never carry a signed/download URL, only a durable pointer. */
export interface SlackMessageFileRef {
  file_id: string;
  name: string;
  mimetype: string | null;
  size_bytes: number | null;
  object_key: string;
  content_hash: string;
}
