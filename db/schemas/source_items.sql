create table source_items (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspaces(id) on delete cascade,
  source_connection_id        uuid not null,
  item_type                   text not null
                                 check (item_type in ('meeting_transcript', 'meeting_notes', 'message', 'coding_session', 'document', 'provider_event')),
  external_id                  text not null,
  external_version             text not null,
  lifecycle_status             text not null default 'received'
                                 check (lifecycle_status in ('received', 'normalized', 'ready', 'superseded', 'deleted', 'quarantined')),
  occurred_at                  timestamptz not null,
  received_at                  timestamptz not null default now(),
  normalized_at                timestamptz,
  content_markdown             text,
  content_hash                 text check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  metadata_json                jsonb not null default '{}',
  sanitized_raw_json           jsonb,
  supersedes_source_item_id    uuid,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  unique (source_connection_id, external_id, external_version),
  unique (id, workspace_id),
  foreign key (source_connection_id, workspace_id)
    references source_connections(id, workspace_id) on delete cascade,
  foreign key (supersedes_source_item_id, workspace_id)
    references source_items(id, workspace_id) on delete restrict,
  check (
    lifecycle_status not in ('normalized', 'ready', 'superseded')
    or (content_markdown is not null and content_hash is not null)
  )
);
