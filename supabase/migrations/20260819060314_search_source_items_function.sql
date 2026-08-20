-- Backs `draft sessions search`. Filters directly on coding_session
-- source_items' metadata_json (already denormalized by
-- materialize-summary.ts) rather than joining agent_sessions.
create or replace function search_source_items(
  p_workspace_id uuid,
  p_query text,
  p_since timestamptz default null,
  p_provider text default null,
  p_user_id uuid default null,
  p_contributor_id uuid default null,
  p_limit int default 20,
  p_offset int default 0
)
returns table (
  source_item_id uuid,
  agent_session_id uuid,
  provider text,
  user_id uuid,
  contributor_id uuid,
  occurred_at timestamptz,
  snippet text
)
language sql
security definer
set search_path = public
stable
as $$
  select
    si.id as source_item_id,
    (si.metadata_json->>'agent_session_id')::uuid as agent_session_id,
    si.metadata_json->>'provider' as provider,
    (si.metadata_json->>'user_id')::uuid as user_id,
    (si.metadata_json->>'contributor_id')::uuid as contributor_id,
    si.occurred_at,
    ts_headline(
      'english', si.content_markdown, websearch_to_tsquery('english', p_query),
      'MaxFragments=2, MaxWords=35, MinWords=15'
    ) as snippet
  from source_items si
  where si.workspace_id = p_workspace_id
    and si.item_type = 'coding_session'
    and si.lifecycle_status = 'ready'
    and to_tsvector('english', si.content_markdown) @@ websearch_to_tsquery('english', p_query)
    and (p_since is null or si.occurred_at >= p_since)
    and (p_provider is null or si.metadata_json->>'provider' = p_provider)
    and (p_user_id is null or (si.metadata_json->>'user_id')::uuid = p_user_id)
    and (p_contributor_id is null or (si.metadata_json->>'contributor_id')::uuid = p_contributor_id)
  order by si.occurred_at desc
  limit p_limit offset p_offset;
$$;

revoke all on function search_source_items(uuid, text, timestamptz, text, uuid, uuid, int, int) from public;
grant execute on function search_source_items(uuid, text, timestamptz, text, uuid, uuid, int, int) to service_role;
