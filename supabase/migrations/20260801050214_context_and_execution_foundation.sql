-- Context and execution foundation: workspace_context_versions, scheduled_tasks,
-- synthesis_runs, synthesis_run_source_items, workspace_events, errors.

-- ── workspace_context_versions ──────────────────────────────────────────

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
    references workspace_context_versions(id, workspace_id) on delete restrict
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
    )
  );

-- ── scheduled_tasks ──────────────────────────────────────────────────────

create table scheduled_tasks (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  source_connection_id     uuid,
  task_type                text not null
                              check (task_type in ('ingest_source', 'synthesize_workspace', 'rebuild_projection')),
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

create trigger scheduled_tasks_set_updated_at
  before update on scheduled_tasks
  for each row execute function set_updated_at();

alter table scheduled_tasks enable row level security;

-- ── synthesis_runs ───────────────────────────────────────────────────────

create table synthesis_runs (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspaces(id) on delete cascade,
  scheduled_task_id           uuid,
  retry_of_run_id             uuid,
  idempotency_key             text not null,
  status                      text not null default 'queued'
                                 check (status in ('queued', 'preparing', 'running', 'validating',
                                                    'committing', 'succeeded', 'failed', 'stale', 'cancelled')),
  trigger_type                text not null
                                 check (trigger_type in ('schedule', 'source_threshold', 'manual', 'retry',
                                                          'stale_requeue', 'seed_test')),
  base_context_version_id     uuid not null,
  attempt                     integer not null default 1 check (attempt > 0),
  prompt_version               text not null,
  outcome                     text check (outcome in ('changed', 'no_change', 'failure', 'stale')),
  result_summary               text,
  result_hash                  text check (result_hash is null or result_hash ~ '^[0-9a-f]{64}$'),
  needs_input_json              jsonb,
  needs_input_resolution        text,
  needs_input_resolved_at       timestamptz,
  needs_input_resolved_by       uuid references users(id) on delete set null,
  started_at                   timestamptz,
  completed_at                 timestamptz,
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  unique (workspace_id, idempotency_key),
  unique (id, workspace_id),
  foreign key (scheduled_task_id, workspace_id)
    references scheduled_tasks(id, workspace_id) on delete restrict,
  foreign key (base_context_version_id, workspace_id)
    references workspace_context_versions(id, workspace_id) on delete restrict,
  foreign key (retry_of_run_id, workspace_id)
    references synthesis_runs(id, workspace_id) on delete restrict
);

create trigger synthesis_runs_set_updated_at
  before update on synthesis_runs
  for each row execute function set_updated_at();

create unique index synthesis_runs_one_active_writer
  on synthesis_runs (workspace_id)
  where status in ('preparing', 'running', 'validating', 'committing');

alter table synthesis_runs enable row level security;

create policy synthesis_runs_select on synthesis_runs
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = synthesis_runs.workspace_id
        and w.organization_id = current_user_org_id()
    )
  );

alter table workspace_context_versions
  add foreign key (synthesis_run_id, workspace_id)
  references synthesis_runs(id, workspace_id) on delete restrict;

-- ── synthesis_run_source_items ──────────────────────────────────────────

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

alter table synthesis_run_source_items enable row level security;

-- ── workspace_events ─────────────────────────────────────────────────────

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
    )
  );

-- ── errors ───────────────────────────────────────────────────────────────

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

alter table errors enable row level security;

create policy errors_select on errors
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = errors.workspace_id
        and w.organization_id = current_user_org_id()
    )
  );

-- ── workspaces.current_context_version_id now has a real target ─────────

alter table workspaces
  add foreign key (current_context_version_id, id)
  references workspace_context_versions(id, workspace_id) on delete restrict;
