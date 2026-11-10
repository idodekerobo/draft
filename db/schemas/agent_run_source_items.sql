-- The sources a run was given, as synthesis_run_source_items holds them.
create table agent_run_source_items (
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  agent_run_id             uuid not null,
  source_item_id           uuid not null,
  position                 integer not null check (position >= 0),
  source_item_version      text not null,
  content_hash             text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_at               timestamptz not null default now(),

  primary key (agent_run_id, source_item_id),
  unique (agent_run_id, position),
  foreign key (agent_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete cascade,
  foreign key (source_item_id, workspace_id)
    references source_items(id, workspace_id) on delete restrict
);

create index agent_run_source_items_source_item_idx
  on agent_run_source_items (source_item_id, workspace_id, source_item_version, content_hash)
  include (agent_run_id);

alter table agent_run_source_items enable row level security;
grant select, insert on table agent_run_source_items to service_role;
