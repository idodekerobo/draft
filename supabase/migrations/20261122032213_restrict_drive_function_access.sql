-- Drive functions run as their owner and must only be callable by the backend service role.
-- Supabase defaults grant anon and authenticated explicitly, so revoking public alone is insufficient.
revoke all on function write_drive_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid,
  text, timestamptz, timestamptz, uuid
) from public, anon, authenticated;

revoke all on function delete_drive_file(uuid, text) from public, anon, authenticated;

revoke all on function search_drive_items(uuid, text, boolean, text, timestamptz, timestamptz, real, uuid, int) from public, anon, authenticated;
