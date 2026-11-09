-- One row per agent run: one agent process started by Draft with one fixed spec.
-- The spec columns (trigger, principal, runtime, permissions, output) are the
-- AgentRunSpec in core/src/agent-run.ts, copied here when the run starts.
create table agent_runs (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  kind                     text not null
                             check (kind in ('interactive', 'routine', 'synthesis', 'summarization')),
  trigger                  jsonb not null,
  principal                jsonb not null default '{"type": "workspace"}',
  runtime                  jsonb not null,
  harness                  text not null,
  model                    text,
  instructions             text not null default '',
  base_context_version_id  uuid not null,
  permissions              jsonb not null default '[]',
  output                   jsonb not null default '{"type": "text"}',
  status                   text not null default 'queued'
                             check (status in ('queued', 'preparing', 'running', 'validating',
                                               'committing', 'succeeded', 'failed', 'stale', 'cancelled')),
  attempt                  integer not null default 1 check (attempt > 0),
  retry_of_run_id          uuid,
  idempotency_key          text not null,
  prompt_version           text,
  -- The live transcript of the run, when it streams to a session.
  session_id               uuid,
  sandbox_machine_id       text,
  summary                  text,
  failure_code             text,
  failure_detail           text,
  started_at               timestamptz,
  completed_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (id, workspace_id),
  unique (workspace_id, idempotency_key),
  foreign key (base_context_version_id, workspace_id)
    references workspace_context_versions(id, workspace_id) on delete restrict,
  foreign key (retry_of_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete restrict,
  foreign key (session_id, workspace_id)
    references sessions(id, workspace_id) on delete set null (session_id)
);

create index agent_runs_workspace_created_idx on agent_runs (workspace_id, created_at desc);
create index agent_runs_session_idx on agent_runs (session_id) where session_id is not null;

-- One active synthesis per workspace: the correctness guard for context commits.
create unique index agent_runs_one_active_synthesis
  on agent_runs (workspace_id)
  where kind = 'synthesis' and status in ('preparing', 'running', 'validating', 'committing');

create trigger agent_runs_set_updated_at
  before update on agent_runs
  for each row execute function set_updated_at();

alter table agent_runs enable row level security;
grant select, insert, update on table agent_runs to service_role;
-- TODO: no `authenticated` policy yet. The backend (service role) is the only
-- reader until a screen needs to show runs.

-- One row per tool call a run makes through the Draft gateway, allowed or not.
create table agent_run_tool_calls (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  agent_run_id   uuid not null,
  tool_name      text not null,
  arguments      jsonb not null default '{}',
  status         text not null
                   check (status in ('ok', 'denied', 'invalid', 'conflict', 'error')),
  result_summary text,
  error_code     text,
  duration_ms    integer check (duration_ms is null or duration_ms >= 0),
  created_at     timestamptz not null default now(),

  unique (id, workspace_id),
  foreign key (agent_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete cascade
);

create index agent_run_tool_calls_run_created_idx on agent_run_tool_calls (agent_run_id, created_at);

alter table agent_run_tool_calls enable row level security;
grant select, insert on table agent_run_tool_calls to service_role;

-- A question an agent asked a person with the request_input tool.
create table agent_run_input_requests (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  agent_run_id   uuid not null,
  tool_call_id   uuid,
  question       text not null,
  options        jsonb,
  status         text not null default 'open'
                   check (status in ('open', 'answered', 'dismissed')),
  answer         text,
  answered_by    uuid references users(id) on delete set null,
  answered_at    timestamptz,
  created_at     timestamptz not null default now(),

  foreign key (agent_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete cascade,
  foreign key (tool_call_id, workspace_id)
    references agent_run_tool_calls(id, workspace_id) on delete set null (tool_call_id)
);

create index agent_run_input_requests_run_idx on agent_run_input_requests (agent_run_id);
create index agent_run_input_requests_open_idx on agent_run_input_requests (workspace_id) where status = 'open';

alter table agent_run_input_requests enable row level security;
grant select, insert, update on table agent_run_input_requests to service_role;
