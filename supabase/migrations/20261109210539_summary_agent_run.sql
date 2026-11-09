-- The agent run that holds this session's summary lease, and so the one that made its summary.
alter table agent_sessions add column summary_agent_run_id uuid;
alter table agent_sessions add constraint agent_sessions_summary_agent_run_fkey
  foreign key (summary_agent_run_id, workspace_id)
  references agent_runs(id, workspace_id) on delete set null (summary_agent_run_id);
create index agent_sessions_summary_agent_run_idx
  on agent_sessions (summary_agent_run_id) where summary_agent_run_id is not null;
