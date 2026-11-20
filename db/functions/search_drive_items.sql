-- Full-text search over shared Google Drive items. Active versions only, unless p_include_history also
-- returns superseded versions. Keyset paging on (rank desc, id asc).
create or replace function search_drive_items(
  p_workspace_id uuid,
  p_query text default null,
  p_include_history boolean default false,
  p_file_id text default null,
  p_modified_after timestamptz default null,
  p_modified_before timestamptz default null,
  p_after_rank real default null,
  p_after_id uuid default null,
  p_limit int default 11
)
returns table (
  id uuid,
  external_id text,
  external_version text,
  title text,
  occurred_at timestamptz,
  created_at timestamptz,
  lifecycle_status text,
  rank real,
  snippet text
)
language sql
security definer
set search_path = public
stable
as $$
  with ranked as (
    select
      si.id,
      si.external_id,
      si.external_version,
      si.metadata_json->>'title' as title,
      si.occurred_at,
      si.created_at,
      si.lifecycle_status,
      si.content_markdown,
      (case when p_query is null then 0 else ts_rank_cd(
        to_tsvector('english', coalesce(si.content_markdown, '')),
        websearch_to_tsquery('english', p_query)
      ) end)::real as rank
    from source_items si
    join connections c
      on c.id = si.connection_id
     and c.workspace_id = si.workspace_id
    where si.workspace_id = p_workspace_id
      and c.provider = 'google_drive'
      and si.visibility = 'shared'
      and (si.lifecycle_status = 'active'
        or (p_include_history and si.lifecycle_status = 'superseded'))
      and (p_file_id is null or si.external_id = p_file_id)
      and (p_modified_after is null or si.occurred_at >= p_modified_after)
      and (p_modified_before is null or si.occurred_at < p_modified_before)
      and (p_query is null or to_tsvector('english', coalesce(si.content_markdown, ''))
        @@ websearch_to_tsquery('english', p_query))
  ),
  paged as (
    select r.*
    from ranked r
    where p_after_rank is null
       or r.rank < p_after_rank
       or (r.rank = p_after_rank and r.id > p_after_id)
    order by r.rank desc, r.id asc
    limit greatest(1, least(p_limit, 101))
  )
  select
    p.id,
    p.external_id,
    p.external_version,
    p.title,
    p.occurred_at,
    p.created_at,
    p.lifecycle_status,
    p.rank,
    (case when p_query is null then left(coalesce(p.content_markdown, ''), 400) else ts_headline(
      'english', coalesce(p.content_markdown, ''), websearch_to_tsquery('english', p_query),
      'MaxFragments=2, MaxWords=35, MinWords=15, StartSel=**, StopSel=**'
    ) end) as snippet
  from paged p
  order by p.rank desc, p.id asc;
$$;

revoke all on function search_drive_items(uuid, text, boolean, text, timestamptz, timestamptz, real, uuid, int) from public;
grant execute on function search_drive_items(uuid, text, boolean, text, timestamptz, timestamptz, real, uuid, int) to service_role;
