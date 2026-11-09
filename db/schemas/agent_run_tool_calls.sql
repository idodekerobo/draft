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
