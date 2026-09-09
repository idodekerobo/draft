-- Per-item visibility + owner, snapshotted at ingest (not a live join to
-- source_connections.connected_by_user_id -- that FK is nullable and
-- cleared on user deletion, which would otherwise silently make a deleted
-- user's historical private items invisible to everyone forever).
alter table source_items
  add column visibility text not null default 'shared'
    check (visibility in ('private', 'shared')),
  add column owner_user_id uuid references users(id) on delete set null;

-- Backfill: only Fireflies is a multi-account, per-connector-private
-- provider today (item 4's actual scope) -- every other existing row keeps
-- the 'shared' default so this migration doesn't retroactively hide
-- coding-session/Slack/GitHub/manual-upload content that was never
-- connector-private in the first place. Owner is snapshotted from the
-- item's source_connection at backfill time.
update source_items si
set visibility = 'private',
    owner_user_id = sc.connected_by_user_id
from source_connections sc
where sc.id = si.source_connection_id
  and sc.provider = 'fireflies';

-- Old signature had 11 params; create-or-replace with a different arg list
-- creates an overload instead of replacing it, so drop it explicitly first.
drop function if exists upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text
);

-- Locks the exact-match row (if any) and every prior 'ready' revision of
-- the same external_id before writing, so a crash or race between finding
-- prior revisions and superseding them can never leave two 'ready' rows for
-- one external_id. Supersedes all matched prior rows and links
-- supersedes_source_item_id to the most recently normalized one.
create or replace function upsert_source_item(
  p_workspace_id uuid,
  p_source_connection_id uuid,
  p_item_type text,
  p_external_id text,
  p_external_version text,
  p_occurred_at timestamptz,
  p_content_markdown text,
  p_content_hash text,
  p_metadata_json jsonb default '{}'::jsonb,
  p_sanitized_raw_json jsonb default null,
  p_lifecycle_status text default 'ready',
  p_visibility text default 'shared',
  p_owner_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_status text;
  v_existing_hash text;
  v_prior_ids uuid[];
  v_supersede_id uuid;
  v_item_id uuid;
  v_changed boolean;
  v_now timestamptz := now();
begin
  select status into v_connection_status
  from source_connections
  where id = p_source_connection_id
    and workspace_id = p_workspace_id
  for update;

  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using
      errcode = 'P0001',
      message = 'connection_inactive';
  end if;

  select content_hash into v_existing_hash
  from source_items
  where source_connection_id = p_source_connection_id
    and external_id = p_external_id
    and external_version = p_external_version
  for update;

  v_changed := v_existing_hash is distinct from p_content_hash;

  with locked as (
    select id, normalized_at, created_at
    from source_items
    where source_connection_id = p_source_connection_id
      and external_id = p_external_id
      and lifecycle_status = 'ready'
      and external_version <> p_external_version
    for update
  )
  select array_agg(id order by normalized_at desc nulls last, created_at desc)
    into v_prior_ids
  from locked;

  v_supersede_id := v_prior_ids[1];

  insert into source_items (
    workspace_id, source_connection_id, item_type, external_id,
    external_version, lifecycle_status, occurred_at, normalized_at,
    content_markdown, content_hash, metadata_json, sanitized_raw_json,
    supersedes_source_item_id, visibility, owner_user_id
  ) values (
    p_workspace_id, p_source_connection_id, p_item_type, p_external_id,
    p_external_version, p_lifecycle_status, p_occurred_at, v_now,
    p_content_markdown, p_content_hash, p_metadata_json, p_sanitized_raw_json,
    v_supersede_id, p_visibility, p_owner_user_id
  )
  on conflict (source_connection_id, external_id, external_version)
  do update set
    item_type = excluded.item_type,
    lifecycle_status = excluded.lifecycle_status,
    occurred_at = excluded.occurred_at,
    normalized_at = excluded.normalized_at,
    content_markdown = excluded.content_markdown,
    content_hash = excluded.content_hash,
    metadata_json = excluded.metadata_json,
    sanitized_raw_json = excluded.sanitized_raw_json,
    supersedes_source_item_id =
      coalesce(source_items.supersedes_source_item_id, excluded.supersedes_source_item_id),
    visibility = excluded.visibility,
    owner_user_id = excluded.owner_user_id
  returning id into v_item_id;

  if v_prior_ids is not null then
    update source_items
    set lifecycle_status = 'superseded'
    where id = any(v_prior_ids);
  end if;

  return jsonb_build_object(
    'item_id', v_item_id,
    'changed', v_changed,
    'superseded_item_ids', coalesce(to_jsonb(v_prior_ids), '[]'::jsonb)
  );
end;
$$;

revoke all on function upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid
) from public;
grant execute on function upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid
) to service_role;

-- search_source_items already scopes to item_type = 'coding_session' (never
-- fireflies today), but add the visibility filter for defense-in-depth and
-- so a future item_type expansion doesn't silently reopen the leak this
-- plan closes. Old signature had 8 params; drop it explicitly first (same
-- overload-vs-replace reasoning as upsert_source_item above).
drop function if exists search_source_items(uuid, text, timestamptz, text, uuid, uuid, int, int);

create or replace function search_source_items(
  p_workspace_id uuid,
  p_query text,
  p_since timestamptz default null,
  p_provider text default null,
  p_user_id uuid default null,
  p_contributor_id uuid default null,
  p_limit int default 20,
  p_offset int default 0,
  p_caller_user_id uuid default null
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
    and (si.visibility = 'shared' or si.owner_user_id = p_caller_user_id)
    and to_tsvector('english', si.content_markdown) @@ websearch_to_tsquery('english', p_query)
    and (p_since is null or si.occurred_at >= p_since)
    and (p_provider is null or si.metadata_json->>'provider' = p_provider)
    and (p_user_id is null or (si.metadata_json->>'user_id')::uuid = p_user_id)
    and (p_contributor_id is null or (si.metadata_json->>'contributor_id')::uuid = p_contributor_id)
  order by si.occurred_at desc
  limit p_limit offset p_offset;
$$;

revoke all on function search_source_items(uuid, text, timestamptz, text, uuid, uuid, int, int, uuid) from public;
grant execute on function search_source_items(uuid, text, timestamptz, text, uuid, uuid, int, int, uuid) to service_role;

-- Defense-in-depth (Scope item 4, kept as a secondary layer -- the primary
-- enforcement is the app-level filter in sessions.ts/sessions-search.ts,
-- since those routes read via serviceClient and bypass RLS entirely). Any
-- future code path that reads source_items via the user's own client
-- (userClient, not serviceClient) gets the same visibility scoping for free.
drop policy if exists source_items_select on source_items;

create policy source_items_select on source_items
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = source_items.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
    and (source_items.visibility = 'shared' or source_items.owner_user_id = auth.uid())
  );
