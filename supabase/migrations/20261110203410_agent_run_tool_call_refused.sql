-- A tool can answer "no" itself (no context yet, a name already taken). That is neither a crash ('error') nor a
-- caller that may not use the tool ('denied'), so the audit row says 'refused' and keeps the tool's code in error_code.
alter table agent_run_tool_calls drop constraint agent_run_tool_calls_status_check;
alter table agent_run_tool_calls
  add constraint agent_run_tool_calls_status_check
  check (status in ('ok', 'refused', 'denied', 'invalid', 'conflict', 'error'));
