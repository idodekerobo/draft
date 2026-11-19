create table agent_query_log (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid references users(id),
  command       text not null,
  surface       text check (surface in ('cli', 'mcp')),
  status        text check (status in ('ok', 'conflict', 'refused', 'denied', 'invalid', 'error')),
  duration_ms   integer check (duration_ms >= 0),
  error_code    text,
  args_json     jsonb not null default '{}',
  result_bytes  int,
  occurred_at   timestamptz not null default now()
);

create index agent_query_log_workspace_occurred_idx
  on agent_query_log (workspace_id, occurred_at);

-- Backend-internal telemetry, written by the service role only. No select
-- policy for `authenticated` yet -- queried directly via SQL/dashboard.
alter table agent_query_log enable row level security;

grant insert on table agent_query_log to service_role;
