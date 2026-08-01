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

-- One active writer per workspace: the correctness guard for atomic commits
-- and, since the inference credential is per-customer, the rate-limit guard too.
create unique index synthesis_runs_one_active_writer
  on synthesis_runs (workspace_id)
  where status in ('preparing', 'running', 'validating', 'committing');

-- TODO: no execution-metadata columns yet (executor_provider, harness, model,
-- input_tokens, output_tokens, estimated_cost_usd, heartbeat_at). Add these
-- back when the execution/worker path is actually built (Plan 0037 task 4) --
-- they were cut early because nothing writes to them yet.
