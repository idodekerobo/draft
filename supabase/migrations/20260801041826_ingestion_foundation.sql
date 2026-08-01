-- Ingestion foundation: credentials, source_connections, source_items.

-- ── credentials ──────────────────────────────────────────────────────────

create table credentials (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  provider                 text not null,
  label                    text,
  encrypted_payload        bytea not null,
  encryption_key_version   text not null,
  status                   text not null default 'active'
                              check (status in ('active', 'revoked', 'expired')),
  expires_at               timestamptz,
  last_used_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (id, workspace_id)
);

create trigger credentials_set_updated_at
  before update on credentials
  for each row execute function set_updated_at();

alter table credentials enable row level security;

-- ── source_connections ──────────────────────────────────────────────────

create table source_connections (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  provider                 text not null
                              check (provider in ('fireflies', 'slack', 'granola', 'claude_session', 'codex_session', 'reserved_other')),
  connection_key           text not null,
  display_name             text,
  external_account_id      text,
  status                   text not null default 'pending'
                              check (status in ('pending', 'active', 'degraded', 'revoked', 'error')),
  credential_id            uuid,
  config_json              jsonb not null default '{}',
  cursor_json              jsonb not null default '{}',
  connected_by_user_id     uuid references users(id) on delete set null,
  last_success_at          timestamptz,
  last_error_at            timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (workspace_id, provider, connection_key),
  unique (id, workspace_id),
  foreign key (credential_id, workspace_id)
    references credentials(id, workspace_id) on delete restrict
);

create trigger source_connections_set_updated_at
  before update on source_connections
  for each row execute function set_updated_at();

alter table source_connections enable row level security;

create policy source_connections_select on source_connections
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = source_connections.workspace_id
        and w.organization_id = current_user_org_id()
    )
  );

-- ── source_items ─────────────────────────────────────────────────────────

create table source_items (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspaces(id) on delete cascade,
  source_connection_id        uuid not null,
  item_type                   text not null
                                 check (item_type in ('transcript', 'message', 'coding_session', 'document', 'provider_event')),
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

create trigger source_items_set_updated_at
  before update on source_items
  for each row execute function set_updated_at();

alter table source_items enable row level security;

create policy source_items_select on source_items
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = source_items.workspace_id
        and w.organization_id = current_user_org_id()
    )
  );

-- ── workspaces.inference_credential_id now has a real target ───────────

alter table workspaces
  add foreign key (inference_credential_id, id)
  references credentials(id, workspace_id) on delete restrict;
