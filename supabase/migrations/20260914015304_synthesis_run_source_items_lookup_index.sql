-- Source-first composite index supporting the successful-membership
-- anti-join in get_pending_synthesis_source_item_ids: for each active
-- source item, that query does a correlated NOT EXISTS lookup keyed on
-- (source_item_id, workspace_id, source_item_version, content_hash), then
-- joins synthesis_run_id -> synthesis_runs (id, workspace_id) to check
-- status/outcome. The existing PK is (synthesis_run_id, source_item_id),
-- which doesn't support that lookup direction at all.
create index synthesis_run_source_items_source_item_idx
  on synthesis_run_source_items (source_item_id, workspace_id, source_item_version, content_hash)
  include (synthesis_run_id);
