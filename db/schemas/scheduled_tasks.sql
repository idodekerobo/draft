-- TODO: no `authenticated` select policy on this table by design. Schedules
-- are read by the scheduling tick and worker (trusted service role), not by
-- desktop/MCP directly.
create table scheduled_tasks (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  source_connection_id     uuid,
  task_type                text not null
                              check (task_type in ('ingest_source', 'synthesize_workspace', 'rebuild_projection', 'summarize_sessions')),
  task_key                 text not null,
  schedule_kind            text not null check (schedule_kind in ('cron', 'interval')),
  cron_expression          text,
  interval_seconds         integer check (interval_seconds > 0),
  timezone                 text not null,
  enabled                  boolean not null default true,
  config_json              jsonb not null default '{}',
  next_due_at              timestamptz,
  last_enqueued_at         timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (id, workspace_id),
  unique (workspace_id, task_type, task_key),
  foreign key (source_connection_id, workspace_id)
    references source_connections(id, workspace_id) on delete cascade,
  check (
    (schedule_kind = 'cron' and cron_expression is not null and interval_seconds is null)
    or (schedule_kind = 'interval' and interval_seconds is not null and cron_expression is null)
  )
);

alter table scheduled_tasks enable row level security;

grant select, insert, update on table scheduled_tasks to service_role;
