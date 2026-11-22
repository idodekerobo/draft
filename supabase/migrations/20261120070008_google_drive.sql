-- A team's Google Drive connection syncs synced Google Drive folders into company context.
alter table connections drop constraint if exists connections_provider_check;
alter table connections add constraint connections_provider_check
  check (provider in ('fireflies', 'slack', 'granola', 'linear', 'github', 'gmail', 'google_drive', 'claude_session', 'codex_session', 'manual_upload', 'mcp'));

-- A synced Google Drive folder: a Google Drive folder or shared drive a person chose. Draft syncs every
-- native file in it into company context. One row per folder per workspace (the unique key is the
-- one-owner rule); the connection that added it owns it. Deleting the connection deletes its rows.
create table synced_google_drive_folders (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  folder_kind       text not null check (folder_kind in ('folder', 'shared_drive')),
  google_folder_id  text not null,
  name              text not null,
  connection_id     uuid not null,
  created_at        timestamptz not null default now(),

  unique (workspace_id, google_folder_id),
  unique (id, workspace_id),
  foreign key (connection_id, workspace_id)
    references connections(id, workspace_id) on delete cascade
);

create index synced_google_drive_folders_connection_idx
  on synced_google_drive_folders (connection_id);

alter table synced_google_drive_folders enable row level security;

grant select, insert, update, delete on table synced_google_drive_folders to service_role;

-- Writes one captured version of a Google Drive file. Drive files are deduped by file id across every
-- google_drive connection in the workspace: an advisory lock on workspace + file id serializes writers,
-- an identical active version anywhere in the workspace is a no-op, and a new version supersedes the
-- prior active rows for the file under every google_drive connection.
create or replace function write_drive_source_item(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_item_type text,
  p_external_id text,
  p_external_version text,
  p_occurred_at timestamptz,
  p_content_markdown text,
  p_content_hash text,
  p_metadata_json jsonb default '{}'::jsonb,
  p_sanitized_raw_json jsonb default null,
  p_lifecycle_status text default 'active',
  p_visibility text default 'shared',
  p_owner_user_id uuid default null,
  p_representation_kind text default 'unknown',
  p_source_time_start timestamptz default null,
  p_source_time_end timestamptz default null,
  p_captured_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_status text;
  v_existing_id uuid;
  v_existing_hash text;
  v_prior_ids uuid[];
  v_item_id uuid;
  v_now timestamptz := now();
begin
  select status into v_connection_status
  from connections
  where id = p_connection_id
    and workspace_id = p_workspace_id
  for update;

  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using
      errcode = 'P0001',
      message = 'connection_inactive';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_workspace_id::text || ':drive:' || p_external_id));

  select si.id into v_existing_id
  from source_items si
  join connections c
    on c.id = si.connection_id
   and c.workspace_id = si.workspace_id
  where si.workspace_id = p_workspace_id
    and c.provider = 'google_drive'
    and si.external_id = p_external_id
    and si.external_version = p_external_version
    and si.lifecycle_status = 'active'
  limit 1;

  if v_existing_id is not null then
    return jsonb_build_object(
      'item_id', v_existing_id,
      'changed', false,
      'superseded_item_ids', '[]'::jsonb
    );
  end if;

  select content_hash into v_existing_hash
  from source_items
  where connection_id = p_connection_id
    and external_id = p_external_id
    and external_version = p_external_version
  for update;

  with locked as (
    select si.id, si.normalized_at, si.created_at
    from source_items si
    join connections c
      on c.id = si.connection_id
     and c.workspace_id = si.workspace_id
    where si.workspace_id = p_workspace_id
      and c.provider = 'google_drive'
      and si.external_id = p_external_id
      and si.lifecycle_status = 'active'
    for update of si
  )
  select array_agg(id order by normalized_at desc nulls last, created_at desc)
    into v_prior_ids
  from locked;

  insert into source_items (
    workspace_id, connection_id, item_type, external_id,
    external_version, lifecycle_status, representation_kind, occurred_at,
    source_time_start, source_time_end, normalized_at, content_markdown,
    content_hash, metadata_json, sanitized_raw_json, supersedes_source_item_id,
    visibility, owner_user_id, captured_session_id
  ) values (
    p_workspace_id, p_connection_id, p_item_type, p_external_id,
    p_external_version, p_lifecycle_status, p_representation_kind, p_occurred_at,
    p_source_time_start, p_source_time_end, v_now, p_content_markdown,
    p_content_hash, p_metadata_json, p_sanitized_raw_json, v_prior_ids[1],
    p_visibility, p_owner_user_id, p_captured_session_id
  )
  on conflict (connection_id, external_id, external_version)
  do update set
    item_type = excluded.item_type,
    lifecycle_status = excluded.lifecycle_status,
    representation_kind = excluded.representation_kind,
    occurred_at = excluded.occurred_at,
    source_time_start = excluded.source_time_start,
    source_time_end = excluded.source_time_end,
    normalized_at = excluded.normalized_at,
    content_markdown = excluded.content_markdown,
    content_hash = excluded.content_hash,
    metadata_json = excluded.metadata_json,
    sanitized_raw_json = excluded.sanitized_raw_json,
    supersedes_source_item_id =
      coalesce(source_items.supersedes_source_item_id, excluded.supersedes_source_item_id),
    visibility = excluded.visibility,
    owner_user_id = excluded.owner_user_id,
    captured_session_id = excluded.captured_session_id,
    updated_at = v_now
  returning id into v_item_id;

  if v_prior_ids is not null then
    update source_items
    set lifecycle_status = 'superseded', updated_at = v_now
    where id = any(v_prior_ids);
  end if;

  return jsonb_build_object(
    'item_id', v_item_id,
    'changed', v_existing_hash is distinct from p_content_hash,
    'superseded_item_ids', coalesce(to_jsonb(v_prior_ids), '[]'::jsonb)
  );
end;
$$;

revoke all on function write_drive_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid,
  text, timestamptz, timestamptz, uuid
) from public;
grant execute on function write_drive_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid,
  text, timestamptz, timestamptz, uuid
) to service_role;

-- Soft-deletes a Google Drive file that left every synced Google Drive folder (trashed, removed or 404):
-- every version under every google_drive connection in the workspace is marked deleted and its text and
-- structured JSON are cleared. If the file comes back, the next write inserts a new row.
create or replace function delete_drive_file(p_workspace_id uuid, p_external_id text)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext(p_workspace_id::text || ':drive:' || p_external_id));

  update source_items si
  set lifecycle_status = 'deleted',
      content_markdown = null,
      content_hash = null,
      sanitized_raw_json = null,
      updated_at = now()
  from connections c
  where c.id = si.connection_id
    and c.workspace_id = si.workspace_id
    and si.workspace_id = p_workspace_id
    and c.provider = 'google_drive'
    and si.external_id = p_external_id
    and (si.lifecycle_status <> 'deleted' or si.content_markdown is not null);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function delete_drive_file(uuid, text) from public;
grant execute on function delete_drive_file(uuid, text) to service_role;

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
