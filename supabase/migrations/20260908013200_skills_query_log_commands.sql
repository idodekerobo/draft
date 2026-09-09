alter table agent_query_log drop constraint agent_query_log_command_check;

alter table agent_query_log add constraint agent_query_log_command_check
  check (command in ('sessions.list', 'sessions.read', 'sessions.search', 'skills.list', 'skills.read'));
