-- A synced Google Drive folder: a Google Drive folder or shared drive a person chose. Draft syncs every
-- native file in it into company context. One row per folder per workspace (the unique key is the
-- one-owner rule); the connection that added it owns it. Deleting the connection deletes its rows.
create table synced_google_drive_folders (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  folder_kind       text not null check (folder_kind in ('folder', 'shared_drive')),
  google_folder_id  text not null,
  name              text not null,
  connection_id     uuid not null,
  created_at        timestamptz not null default now(),

  unique (workspace_id, google_folder_id),
  unique (id, workspace_id),
  foreign key (connection_id, workspace_id)
    references connections(id, workspace_id) on delete cascade
);

create index synced_google_drive_folders_connection_idx
  on synced_google_drive_folders (connection_id);

alter table synced_google_drive_folders enable row level security;

grant select, insert, update, delete on table synced_google_drive_folders to service_role;
