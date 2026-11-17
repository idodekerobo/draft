-- The event inbox. One row per (routine, thing that should wake it): a timer, a webhook
-- (fanned out at enqueue), or Run now. Statuses: pending -> claimed -> done | skipped | failed | dead.
-- dedupe_key: '<task>:timer:<occurrence ISO>', '<task>:manual:<uuid>', '<task>:<event_name>:<provider id>'.
-- concurrency_key: the task id for timers and manual; for webhooks the subject, e.g. 'github:org/repo#42'.
-- Service role only; no authenticated policy.
create table agent_events (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  scheduled_task_id  uuid not null,
  origin             text not null check (origin in ('schedule', 'webhook', 'manual', 'agent')),
  event_name         text not null,
  dedupe_key         text not null,
  concurrency_key    text not null,
  source_item_id     uuid,
  payload            jsonb not null default '{}',
  status             text not null default 'pending'
                       check (status in ('pending', 'claimed', 'done', 'skipped', 'failed', 'dead')),
  attempts           integer not null default 0,
  lease_until        timestamptz,
  claimed_by_run_id  uuid,
  failure_code       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (id, workspace_id),
  unique (workspace_id, dedupe_key),
  foreign key (scheduled_task_id, workspace_id) references scheduled_tasks(id, workspace_id),
  foreign key (source_item_id, workspace_id) references source_items(id, workspace_id),
  foreign key (claimed_by_run_id, workspace_id) references agent_runs(id, workspace_id)
);

create index agent_events_ready_idx on agent_events (created_at) where status = 'pending';
create index agent_events_lease_idx on agent_events (lease_until) where status = 'claimed';
create index agent_events_task_key_idx on agent_events (scheduled_task_id, concurrency_key)
  where status in ('pending', 'claimed');

alter table agent_events enable row level security;
grant select, insert, update on table agent_events to service_role;
