-- TODO: no `authenticated` select policy on this table by design. Schedules
-- are read by the scheduling tick and worker (trusted service role), not by
-- desktop/MCP directly.
create table scheduled_tasks (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  connection_id            uuid,
  task_type                text not null
                              check (task_type in ('ingest_source', 'synthesize_workspace', 'rebuild_projection', 'summarize_sessions', 'slack_backfill', 'agent_routine')),
  task_key                 text not null,
  schedule_kind            text not null
                              constraint scheduled_tasks_schedule_kind_check
                              check (schedule_kind in ('cron', 'interval', 'once')),
  cron_expression          text,
  interval_seconds         integer check (interval_seconds > 0),
  timezone                 text not null,
  enabled                  boolean not null default true,
  -- agent_routine: prompt, harness, model, title and toolset.
  config_json              jsonb not null default '{}',
  next_due_at              timestamptz,
  -- Set when a person deletes the routine. The row stays for its past runs.
  deleted_at               timestamptz,
  last_enqueued_at        timestamptz,
  -- Set by claim_due_scheduled_tasks and cleared when the tick writes the real next_due_at.
  claimed_occurrence_at    timestamptz,
  -- once only: when it should run, and when it fired. A fired one-shot stays so it can be found and run again.
  run_at                   timestamptz,
  fired_at                 timestamptz,
  -- Who made it. created_by_user_id is always the human owner. 'cli'/'mcp' may be a person or an
  -- outside agent acting for them; 'run' is a Draft agent run; 'system' is a built-in task.
  created_via              text not null default 'app'
                              check (created_via in ('app', 'web_app', 'desktop_app', 'cli', 'mcp', 'run', 'system')),
  created_by_run_id        uuid,
  -- 0 for people; a run-made routine is its parent routine's depth + 1.
  trigger_depth            integer not null default 0 check (trigger_depth >= 0),
  visibility               text not null default 'shared' check (visibility in ('private', 'shared')),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  updated_by_user_id       uuid references users(id) on delete set null,
  created_by_user_id       uuid references users(id) on delete set null,

  unique (id, workspace_id),
  unique (workspace_id, task_type, task_key),
  foreign key (connection_id, workspace_id)
    references connections(id, workspace_id) on delete cascade,
  foreign key (created_by_run_id, workspace_id) references agent_runs(id, workspace_id),
  constraint scheduled_tasks_schedule_shape check (
    (schedule_kind = 'cron' and cron_expression is not null and interval_seconds is null and run_at is null)
    or (schedule_kind = 'interval' and interval_seconds is not null and cron_expression is null and run_at is null)
    or (schedule_kind = 'once' and run_at is not null and cron_expression is null and interval_seconds is null)
  ),
  constraint scheduled_tasks_created_by_run check ((created_via = 'run') = (created_by_run_id is not null))
);

create index scheduled_tasks_due_idx on scheduled_tasks (next_due_at)
  where enabled and deleted_at is null and next_due_at is not null;
create index scheduled_tasks_created_by_run_idx on scheduled_tasks (created_by_run_id)
  where created_by_run_id is not null;

alter table scheduled_tasks enable row level security;

grant select, insert, update on table scheduled_tasks to service_role;

create trigger scheduled_tasks_set_updated_at
  before update on scheduled_tasks
  for each row execute function set_updated_at();
