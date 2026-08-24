-- 20260820191443_fix_upsert_source_item_for_update_aggregate.sql (landed on
-- main independently, applying its own FOR-UPDATE-vs-aggregate fix) sorts
-- between this branch's 20260820190349_hosted_integration_lifecycle.sql
-- (which added the connection-status gate) and 20260820210709. On a full
-- from-scratch replay, that migration's `create or replace function
-- upsert_source_item` -- an older definition without the status gate --
-- applies last and silently drops the gate, letting pending/error/revoked
-- connections accept writes again. Caught by the disposable-Postgres
-- lifecycle integration suite, which a from-scratch `supabase db reset`
-- exercises exactly this way. Re-applies the complete, correct definition
-- (status gate + the FOR-UPDATE/aggregate fix) so the final state is
-- correct regardless of replay order. No behavior change from what
-- 20260820190349 already intended -- this only fixes migration ordering.
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
  p_lifecycle_status text default 'ready'
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
  -- Connection is always the first row lock in lifecycle writes. This makes
  -- an in-flight ingest and disconnect serialize: whichever takes this lock
  -- first is the operation that truthfully completes first.
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

  -- Lock the exact-match row (same connection/external_id/external_version)
  -- if one already exists, so two concurrent writers of the identical
  -- revision can't race each other.
  select content_hash into v_existing_hash
  from source_items
  where source_connection_id = p_source_connection_id
    and external_id = p_external_id
    and external_version = p_external_version
  for update;

  v_changed := v_existing_hash is distinct from p_content_hash;

  -- Lock every prior ready revision of this logical item before deciding
  -- anything else, so a concurrent caller can never observe -- or leave
  -- behind -- two 'ready' rows for the same external_id. Postgres rejects
  -- FOR UPDATE combined directly with an aggregate, so the lock happens in
  -- a CTE and array_agg runs over the already-locked rows outside it.
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
    supersedes_source_item_id
  ) values (
    p_workspace_id, p_source_connection_id, p_item_type, p_external_id,
    p_external_version, p_lifecycle_status, p_occurred_at, v_now,
    p_content_markdown, p_content_hash, p_metadata_json, p_sanitized_raw_json,
    v_supersede_id
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
      coalesce(source_items.supersedes_source_item_id, excluded.supersedes_source_item_id)
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
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text
) from public;
grant execute on function upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text
) to service_role;
