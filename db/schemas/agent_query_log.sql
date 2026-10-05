create table agent_query_log (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid references users(id),
  command       text not null
                  check (command in (
                    'sessions.list', 'sessions.read', 'sessions.search',
                    'skills.list', 'skills.read',
                    'sources.search', 'sources.read',
                    'context.read', 'context.export',
                    'routines.list',
                    'mcp.context.list', 'mcp.context.read', 'mcp.context.export',
                    'mcp.sessions.list', 'mcp.sessions.read', 'mcp.sessions.search',
                    'mcp.skills.list', 'mcp.skills.read', 'mcp.skills.add',
                    'mcp.sources.search', 'mcp.sources.read',
                    'mcp.routines.list'
                  )),
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
