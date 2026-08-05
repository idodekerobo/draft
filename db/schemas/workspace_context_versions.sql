-- Append-only: no updated_at. Application roles may insert/select but not
-- update or delete rows during normal operation.
create table workspace_context_versions (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspaces(id) on delete cascade,
  version_number              bigint not null check (version_number > 0),
  previous_version_id         uuid,
  documents_json               jsonb not null
                                 check (jsonb_typeof(documents_json) = 'object'),
  content_hash                 text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  creation_reason               text not null
                                 check (creation_reason in ('seed', 'synthesis', 'manual_edit', 'restore')),
  synthesis_run_id             uuid,
  restored_from_version_id     uuid,
  summary                      text not null,
  created_at                   timestamptz not null default now(),

  unique (workspace_id, version_number),
  unique (id, workspace_id),
  foreign key (previous_version_id, workspace_id)
    references workspace_context_versions(id, workspace_id) on delete restrict,
  foreign key (restored_from_version_id, workspace_id)
    references workspace_context_versions(id, workspace_id) on delete restrict,
  foreign key (synthesis_run_id, workspace_id)
    references synthesis_runs(id, workspace_id) on delete restrict
);

create unique index workspace_context_versions_one_per_run
  on workspace_context_versions (synthesis_run_id)
  where synthesis_run_id is not null;

alter table workspace_context_versions enable row level security;

create policy workspace_context_versions_select on workspace_context_versions
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = workspace_context_versions.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table workspace_context_versions to authenticated;
grant select on table workspace_context_versions to service_role;
