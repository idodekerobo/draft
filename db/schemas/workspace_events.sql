-- Immutable feed: no updated_at. sequence_number is allocated by app code
-- while holding a lock on the workspace row, not by a DB sequence, so a gap
-- from a rolled-back transaction never appears.
create table workspace_events (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  sequence_number          bigint not null check (sequence_number > 0),
  event_type               text not null
                              check (event_type in ('source_items_added', 'context_updated', 'no_change',
                                                     'needs_input', 'input_resolved', 'source_delayed',
                                                     'context_restored', 'manual_edit')),
  synthesis_run_id         uuid,
  source_connection_id     uuid,
  context_version_id       uuid,
  summary                  text not null,
  payload_json             jsonb not null default '{}',
  occurred_at              timestamptz not null,
  created_at               timestamptz not null default now(),

  unique (workspace_id, sequence_number),
  foreign key (synthesis_run_id, workspace_id)
    references synthesis_runs(id, workspace_id) on delete restrict,
  foreign key (source_connection_id, workspace_id)
    references source_connections(id, workspace_id) on delete restrict,
  foreign key (context_version_id, workspace_id)
    references workspace_context_versions(id, workspace_id) on delete restrict
);

alter table workspace_events enable row level security;

create policy workspace_events_select on workspace_events
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = workspace_events.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table workspace_events to authenticated;
grant select, insert on table workspace_events to service_role;
