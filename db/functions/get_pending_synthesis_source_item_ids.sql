create or replace function get_pending_synthesis_source_item_ids(
  p_workspace_id uuid,
  p_reprocess boolean default false
)
returns table (source_item_id uuid)
language sql
security definer
set search_path = public
stable
as $$
  select si.id
  from source_items si
  where si.workspace_id = p_workspace_id
    and si.lifecycle_status = 'active'
    and (
      p_reprocess
      or not exists (
        select 1
        from synthesis_run_source_items srsi
        join synthesis_runs sr
          on sr.id = srsi.synthesis_run_id
         and sr.workspace_id = srsi.workspace_id
        where srsi.workspace_id = si.workspace_id
          and srsi.source_item_id = si.id
          and srsi.source_item_version = si.external_version
          and srsi.content_hash = si.content_hash
          and sr.status = 'succeeded'
          and sr.outcome in ('changed', 'no_change')
      )
    )
  order by si.occurred_at asc, si.id asc;
$$;

revoke all on function get_pending_synthesis_source_item_ids(uuid, boolean) from public;
grant execute on function get_pending_synthesis_source_item_ids(uuid, boolean) to service_role;
