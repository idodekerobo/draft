-- Soft-deletes a Google Drive file that left every synced Google Drive folder (trashed, removed or 404):
-- every version under every google_drive connection in the workspace is marked deleted and its text and
-- structured JSON are cleared. If the file comes back, the next write inserts a new row.
create or replace function delete_drive_file(p_workspace_id uuid, p_external_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext(p_workspace_id::text || ':drive:' || p_external_id));

  update source_items si
  set lifecycle_status = 'deleted',
      content_markdown = null,
      content_hash = null,
      sanitized_raw_json = null,
      updated_at = now()
  from connections c
  where c.id = si.connection_id
    and c.workspace_id = si.workspace_id
    and si.workspace_id = p_workspace_id
    and c.provider = 'google_drive'
    and si.external_id = p_external_id
    and (si.lifecycle_status <> 'deleted' or si.content_markdown is not null);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function delete_drive_file(uuid, text) from public, anon, authenticated;
grant execute on function delete_drive_file(uuid, text) to service_role;
