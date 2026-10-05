alter table agent_query_log drop constraint agent_query_log_command_check;
alter table agent_query_log add constraint agent_query_log_command_check
  check (command in (
    'sessions.list', 'sessions.read', 'sessions.search',
    'skills.list', 'skills.read', 'context.read',
    'sources.search', 'sources.read',
    'routines.list', 'context.export',
    'mcp.context.list', 'mcp.context.read', 'mcp.context.export',
    'mcp.sessions.list', 'mcp.sessions.read', 'mcp.sessions.search',
    'mcp.skills.list', 'mcp.skills.read', 'mcp.skills.add',
    'mcp.sources.search', 'mcp.sources.read',
    'mcp.routines.list'
  ));
