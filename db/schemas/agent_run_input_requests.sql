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
