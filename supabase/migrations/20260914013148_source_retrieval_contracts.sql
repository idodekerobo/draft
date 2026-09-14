alter table source_items
  add column representation_kind text not null default 'unknown'
    check (representation_kind in ('summary', 'source', 'mixed', 'unknown')),
  add column source_time_start timestamptz,
  add column source_time_end timestamptz,
  add column agent_session_id uuid;

comment on column source_items.representation_kind is
  'Meaning of content_markdown: summary, rendered source, mixed summary/source, or unknown.';
comment on column source_items.source_time_start is
  'Earliest known original-source event time; null means unknown.';
comment on column source_items.source_time_end is
  'Latest known original-source event time; null means unknown.';
comment on column source_items.agent_session_id is
  'Typed link to the raw coding session. metadata_json.agent_session_id remains for compatibility.';

alter table source_items
  add constraint source_items_time_range_check
    check (source_time_start is null or source_time_end is null or source_time_start <= source_time_end),
  add constraint source_items_agent_session_workspace_fkey
    foreign key (agent_session_id, workspace_id)
    references agent_sessions(id, workspace_id) on delete restrict;

update source_items si
set agent_session_id = (si.metadata_json->>'agent_session_id')::uuid
from agent_sessions a
where si.item_type = 'coding_session'
  and si.metadata_json->>'agent_session_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  and a.id = (si.metadata_json->>'agent_session_id')::uuid
  and a.workspace_id = si.workspace_id;

update source_items si
set representation_kind = case
  when si.item_type = 'coding_session' then 'summary'
  when sc.provider = 'fireflies' then 'summary'
  when sc.provider = 'granola' and jsonb_array_length(coalesce(si.sanitized_raw_json->'transcript', '[]'::jsonb)) > 0 then 'mixed'
  when sc.provider = 'slack' or si.item_type in ('document', 'provider_event') then 'source'
  else 'unknown'
end
from source_connections sc
where sc.id = si.source_connection_id
  and sc.workspace_id = si.workspace_id;

update source_items
set source_time_start = case
      when metadata_json->>'first_message_ts' ~ '^[0-9]+(\.[0-9]+)?$'
        then to_timestamp((metadata_json->>'first_message_ts')::double precision)
      else null
    end,
    source_time_end = case
      when metadata_json->>'last_message_ts' ~ '^[0-9]+(\.[0-9]+)?$'
        then to_timestamp((metadata_json->>'last_message_ts')::double precision)
      else null
    end
where item_type = 'message';

update source_items
set source_time_start = occurred_at,
    source_time_end = occurred_at
where source_time_start is null
  and source_time_end is null
  and item_type in ('meeting_transcript', 'meeting_notes', 'provider_event', 'coding_session');

alter table source_items drop constraint source_items_lifecycle_status_check;
alter table source_items drop constraint source_items_check;

update source_items set lifecycle_status = 'active' where lifecycle_status = 'ready';

alter table source_items
  add constraint source_items_lifecycle_status_check
    check (lifecycle_status in ('received', 'normalized', 'active', 'superseded', 'deleted', 'quarantined')),
  add constraint source_items_content_required_check
    check (
      lifecycle_status not in ('normalized', 'active', 'superseded')
      or (content_markdown is not null and content_hash is not null)
    );

alter table agent_sessions
  add column transcript_revision bigint not null default 1
    check (transcript_revision > 0);

comment on column agent_sessions.transcript_revision is
  'Incremented whenever the complete stored transcript is replaced; source read cursors bind to it.';

create index source_items_agent_session_idx
  on source_items (workspace_id, agent_session_id)
  where agent_session_id is not null;

create index slack_messages_pending_materialization_idx
  on slack_messages (workspace_id, source_connection_id, channel_id, message_ts, id)
  where source_item_id is null;

alter table agent_query_log drop constraint agent_query_log_command_check;
alter table agent_query_log add constraint agent_query_log_command_check
  check (command in (
    'sessions.list', 'sessions.read', 'sessions.search',
    'skills.list', 'skills.read', 'context.read',
    'sources.search', 'sources.read',
    'mcp.context.list', 'mcp.context.read',
    'mcp.sessions.list', 'mcp.sessions.read', 'mcp.sessions.search',
    'mcp.skills.list', 'mcp.skills.read',
    'mcp.sources.search', 'mcp.sources.read'
  ));
