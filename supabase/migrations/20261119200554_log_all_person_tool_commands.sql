alter table agent_query_log drop constraint agent_query_log_command_check;
alter table agent_query_log add constraint agent_query_log_command_check
  check (command in (
    'context.list', 'context.read', 'context.export',
    'sessions.list', 'sessions.read', 'sessions.search',
    'skills.list', 'skills.read', 'skills.add', 'skills.update', 'skills.delete',
    'sources.search', 'sources.list', 'sources.read',
    'activity.list', 'integrations.list', 'integrations.connect',
    'routines.list', 'routines.options', 'routines.create', 'routines.update',
    'routines.delete', 'routines.run', 'routines.runs',
    'slack.list_channels', 'slack.read_channel', 'slack.post_message',
    'people.find', 'people.create', 'people.add_identity', 'people.notify',
    'people.approve', 'people.reject',
    'mcp.context.list', 'mcp.context.read', 'mcp.context.export',
    'mcp.sessions.list', 'mcp.sessions.read', 'mcp.sessions.search',
    'mcp.skills.list', 'mcp.skills.read', 'mcp.skills.add',
    'mcp.sources.search', 'mcp.sources.list', 'mcp.sources.read',
    'mcp.activity.list', 'mcp.integrations.list', 'mcp.integrations.connect',
    'mcp.routines.list', 'mcp.routines.options', 'mcp.routines.create',
    'mcp.routines.update', 'mcp.routines.delete', 'mcp.routines.run', 'mcp.routines.runs',
    'mcp.slack.list_channels', 'mcp.slack.read_channel', 'mcp.slack.post_message',
    'mcp.people.find', 'mcp.people.create', 'mcp.people.add_identity', 'mcp.people.notify',
    'mcp.people.approve', 'mcp.people.reject'
  ));
