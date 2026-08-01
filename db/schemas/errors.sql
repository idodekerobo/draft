-- Dumb append-only log: no updated_at, no status. `message`/`detail_json` must
-- never contain tokens, transcript bodies, raw model output, or signed
-- provider URLs -- a code-review invariant, not a schema constraint.
create table errors (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  source_connection_id     uuid,
  scheduled_task_id        uuid,
  synthesis_run_id         uuid,
  operation                text not null
                              check (operation in ('ingestion', 'scheduling', 'queue', 'execution',
                                                    'validation', 'commit', 'projection', 'auth', 'read')),
  message                  text not null,
  detail_json              jsonb not null default '{}',
  stack_trace              text,
  created_at               timestamptz not null default now(),

  foreign key (source_connection_id, workspace_id)
    references source_connections(id, workspace_id) on delete restrict,
  foreign key (scheduled_task_id, workspace_id)
    references scheduled_tasks(id, workspace_id) on delete restrict,
  foreign key (synthesis_run_id, workspace_id)
    references synthesis_runs(id, workspace_id) on delete restrict
);
