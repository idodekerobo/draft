create or replace function search_sources(
  p_workspace_id uuid,
  p_caller_user_id uuid,
  p_query text,
  p_provider text default null,
  p_types text[] default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_after_rank real default null,
  p_after_occurred_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 11
)
returns table (
  source_item_id uuid,
  source_version text,
  title text,
  provider text,
  item_type text,
  representation_kind text,
  occurred_at timestamptz,
  source_time_start timestamptz,
  source_time_end timestamptz,
  metadata_json jsonb,
  content_markdown text,
  sanitized_raw_json jsonb,
  agent_session_id uuid,
  excerpt text,
  rank real
)
language sql
security definer
set search_path = public
stable
as $$
  with ranked as (
    select
      si.id,
      si.external_version,
      coalesce(si.metadata_json->>'title', si.metadata_json->>'project') as title,
      sc.provider,
      si.item_type,
      si.representation_kind,
      si.occurred_at,
      si.source_time_start,
      si.source_time_end,
      si.metadata_json,
      si.content_markdown,
      si.sanitized_raw_json,
      si.agent_session_id,
      ts_headline(
        'english', coalesce(si.content_markdown, ''), websearch_to_tsquery('english', p_query),
        'MaxFragments=2, MaxWords=35, MinWords=15, StartSel=**, StopSel=**'
      ) as excerpt,
      ts_rank_cd(
        to_tsvector('english', coalesce(si.content_markdown, '')),
        websearch_to_tsquery('english', p_query)
      )::real as rank
    from source_items si
    join source_connections sc
      on sc.id = si.source_connection_id
     and sc.workspace_id = si.workspace_id
    where si.workspace_id = p_workspace_id
      and si.lifecycle_status = 'active'
      and (si.visibility = 'shared' or si.owner_user_id = p_caller_user_id)
      and (p_provider is null or sc.provider = p_provider)
      and (p_types is null or si.item_type = any(p_types))
      and (p_since is null or coalesce(si.source_time_end, si.source_time_start, si.occurred_at) >= p_since)
      and (p_until is null or coalesce(si.source_time_start, si.source_time_end, si.occurred_at) < p_until)
      and to_tsvector('english', coalesce(si.content_markdown, ''))
        @@ websearch_to_tsquery('english', p_query)
  )
  select
    r.id,
    r.external_version,
    r.title,
    r.provider,
    r.item_type,
    r.representation_kind,
    r.occurred_at,
    r.source_time_start,
    r.source_time_end,
    r.metadata_json,
    r.content_markdown,
    r.sanitized_raw_json,
    r.agent_session_id,
    r.excerpt,
    r.rank
  from ranked r
  where p_after_rank is null
     or r.rank < p_after_rank
     or (r.rank = p_after_rank and r.occurred_at < p_after_occurred_at)
     or (r.rank = p_after_rank and r.occurred_at = p_after_occurred_at and r.id > p_after_id)
  order by r.rank desc, r.occurred_at desc, r.id asc
  limit greatest(1, least(p_limit, 101));
$$;

revoke all on function search_sources(uuid, uuid, text, text, text[], timestamptz, timestamptz, real, timestamptz, uuid, int) from public;
grant execute on function search_sources(uuid, uuid, text, text, text[], timestamptz, timestamptz, real, timestamptz, uuid, int) to service_role;
