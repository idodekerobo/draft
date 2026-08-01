-- Immutable membership rows: no updated_at. No `authenticated` select policy
-- -- read through synthesis_runs; this join table is service-role only for now.
create table synthesis_run_source_items (
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  synthesis_run_id         uuid not null,
  source_item_id           uuid not null,
  position                 integer not null check (position >= 0),
  source_item_version      text not null,
  content_hash             text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at               timestamptz not null default now(),

  primary key (synthesis_run_id, source_item_id),
  unique (synthesis_run_id, position),
  foreign key (synthesis_run_id, workspace_id)
    references synthesis_runs(id, workspace_id) on delete cascade,
  foreign key (source_item_id, workspace_id)
    references source_items(id, workspace_id) on delete restrict
);
