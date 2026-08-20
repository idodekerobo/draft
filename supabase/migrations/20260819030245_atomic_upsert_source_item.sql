-- Makes upsertSourceItem transactional (plan 0045, Decision 4).
--
-- The prior TS implementation did three separate round trips: select prior
-- ready revisions, upsert the new row, update the old ones to superseded.
-- A failure or race between the second and third step could leave two
-- 'ready' rows for one external_id, breaking the "exactly one ready row per
-- external_id" invariant every synthesis/read path assumes. This locks the
-- relevant rows and does all three steps in one transaction, following the
-- lock-then-reverify pattern commit_synthesis_run already established.
--
-- Also fixes a narrower bug in the old code: when more than one prior
-- 'ready' row existed for an external_id (which the invariant says should
-- never happen, but wasn't previously enforced atomically), only the first
-- one found got linked via supersedes_source_item_id even though all of
-- them were marked superseded. This version supersedes all matched rows
-- and links to the most recently normalized one.
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
  v_existing_hash text;
  v_prior_ids uuid[];
  v_supersede_id uuid;
  v_item_id uuid;
  v_changed boolean;
  v_now timestamptz := now();
begin
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
  -- behind -- two 'ready' rows for the same external_id.
  select array_agg(id order by normalized_at desc nulls last, created_at desc)
    into v_prior_ids
  from source_items
  where source_connection_id = p_source_connection_id
    and external_id = p_external_id
    and lifecycle_status = 'ready'
    and external_version <> p_external_version
  for update;

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
