-- Which agent_events each run consumed. A run can batch many events.
create table agent_run_events (
  agent_run_id    uuid not null,
  agent_event_id  uuid not null,
  workspace_id    uuid not null,
  primary key (agent_run_id, agent_event_id),
  foreign key (agent_run_id, workspace_id) references agent_runs(id, workspace_id) on delete cascade,
  foreign key (agent_event_id, workspace_id) references agent_events(id, workspace_id) on delete cascade
);

alter table agent_run_events enable row level security;
grant select, insert, update on table agent_run_events to service_role;
