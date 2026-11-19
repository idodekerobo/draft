-- Lists the folder snapshots in session-seeds that no session needs any more: those of ended sessions, and those
-- of sessions with no row that are older than p_orphan_before (an upload that never started). The reconcile sweep
-- deletes them, p_limit at a time. The object name holds <workspace>/<session>/seed.tar.gz.
create or replace function list_stale_session_seeds(p_orphan_before timestamptz, p_limit integer)
returns table (object_name text)
language sql
stable
security definer
set search_path = public, storage
as $$
  with seeds as materialized (
    select o.name, o.created_at, split_part(o.name, '/', 2)::uuid as session_id
    from storage.objects o
    where o.bucket_id = 'session-seeds'
      and o.name ~ '^[^/]+/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/seed\.tar\.gz$'
  )
  select s.name
  from seeds s
  left join sessions ss on ss.id = s.session_id
  where ss.status = 'ended'
     or (ss.id is null and s.created_at < p_orphan_before)
  order by s.created_at
  limit p_limit;
$$;

revoke all on function list_stale_session_seeds(timestamptz, integer) from public;
grant execute on function list_stale_session_seeds(timestamptz, integer) to service_role;
