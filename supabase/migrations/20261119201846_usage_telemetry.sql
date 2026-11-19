alter table agent_query_log drop constraint agent_query_log_command_check;
alter table agent_query_log
  add column surface text check (surface in ('cli', 'mcp')),
  add column status text check (status in ('ok', 'conflict', 'refused', 'denied', 'invalid', 'error')),
  add column duration_ms integer check (duration_ms >= 0),
  add column error_code text;

-- Preserve historical app records; their web/desktop surface cannot be reconstructed.
alter table scheduled_tasks drop constraint scheduled_tasks_created_via_check;
alter table scheduled_tasks add constraint scheduled_tasks_created_via_check
  check (created_via in ('app', 'web_app', 'desktop_app', 'cli', 'mcp', 'run', 'system'));
