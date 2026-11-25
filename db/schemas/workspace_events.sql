-- The workspace's history. Immutable: no updated_at. sequence_number is allocated by append_workspace_event
-- while holding a lock on the workspace row, not by a DB sequence, so a gap from a rolled-back transaction never appears.
-- A shared row is read by any member. A private row is read only by its audience person.
create table workspace_events (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  sequence_number          bigint not null check (sequence_number > 0),
  -- The code checks the values (WorkspaceEventType), so a new event needs no migration.
  event_type               text not null,
  agent_run_id             uuid,
  connection_id            uuid,
  context_version_id       uuid,
  summary                  text not null,
  payload_json             jsonb not null default '{}',
  occurred_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  visibility               text not null default 'shared' check (visibility in ('shared', 'private')),
  audience_person_id       uuid,

  unique (workspace_id, sequence_number),
  foreign key (audience_person_id, workspace_id)
    references people(id, workspace_id) on delete set null (audience_person_id),
  foreign key (agent_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete restrict,
  foreign key (connection_id, workspace_id)
    references connections(id, workspace_id) on delete restrict,
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
    and (
      workspace_events.visibility = 'shared'
      or workspace_events.audience_person_id = current_user_person_id(workspace_events.workspace_id)
    )
  );

grant select on table workspace_events to authenticated;
grant select, insert on table workspace_events to service_role;

-- Signals the workspace topic (see db/functions/signal_workspace_events.sql).
create trigger workspace_events_signal
  after insert on workspace_events
  referencing new table as new_rows
  for each statement execute function signal_workspace_events();

create index workspace_events_agent_run_idx on workspace_events (agent_run_id) where agent_run_id is not null;
