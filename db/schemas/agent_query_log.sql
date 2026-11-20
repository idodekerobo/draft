create table agent_query_log (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid references users(id),
  command       text not null check (command in (
    'context.list', 'context.read', 'context.export',
    'sessions.list', 'sessions.read', 'sessions.search',
    'skills.list', 'skills.read', 'skills.add', 'skills.update', 'skills.delete',
    'sources.search', 'sources.list', 'sources.read',
    'activity.list', 'integrations.list', 'integrations.connect',
    'routines.list', 'routines.options', 'routines.create', 'routines.update',
    'routines.delete', 'routines.run', 'routines.runs',
    'slack.list_channels', 'slack.read_channel', 'slack.post_message',
    'people.find', 'people.create', 'people.add_identity', 'people.notify', 'people.notification_status',
    'people.approve', 'people.reject',
    'mcp.context.list', 'mcp.context.read', 'mcp.context.export',
    'mcp.sessions.list', 'mcp.sessions.read', 'mcp.sessions.search',
    'mcp.skills.list', 'mcp.skills.read', 'mcp.skills.add',
    'mcp.sources.search', 'mcp.sources.list', 'mcp.sources.read',
    'mcp.activity.list', 'mcp.integrations.list', 'mcp.integrations.connect',
    'mcp.routines.list', 'mcp.routines.options', 'mcp.routines.create',
    'mcp.routines.update', 'mcp.routines.delete', 'mcp.routines.run', 'mcp.routines.runs',
    'mcp.slack.list_channels', 'mcp.slack.read_channel', 'mcp.slack.post_message',
    'mcp.people.find', 'mcp.people.create', 'mcp.people.add_identity', 'mcp.people.notify', 'mcp.people.notification_status',
    'mcp.people.approve', 'mcp.people.reject'
  )),
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
