-- The versions in which one document changed, newest first. A version counts when the document's sha256
-- differs from the version before it, including the version that created it. Only the newest p_scan
-- versions are read, so the cost does not grow with the workspace's whole history.
create or replace function context_document_history(
  p_workspace_id uuid,
  p_path text,
  p_limit integer default 10,
  p_scan integer default 300
)
returns table (
  version_id uuid,
  version_number bigint,
  created_at timestamptz,
  creation_reason text,
  agent_run_id uuid,
  summary text,
  sha256 text
)
language sql
security definer
set search_path = public
stable
as $$
  with window_versions as (
    select v.id, v.version_number, v.created_at, v.creation_reason, v.agent_run_id, v.summary,
           v.documents_json -> p_path ->> 'sha256' as sha
    from workspace_context_versions v
    where v.workspace_id = p_workspace_id
    order by v.version_number desc
    limit greatest(p_scan, 1) + 1
  ),
  compared as (
    select w.*,
           lead(w.sha) over (order by w.version_number desc) as older_sha,
           lead(w.version_number) over (order by w.version_number desc) as older_number
    from window_versions w
  )
  select c.id, c.version_number, c.created_at, c.creation_reason, c.agent_run_id, c.summary, c.sha
  from compared c
  -- The oldest row of the window has nothing to compare with, unless it is the first version.
  where (c.older_number is not null or c.version_number = 1)
    and c.sha is distinct from c.older_sha
  order by c.version_number desc
  limit greatest(p_limit, 1);
$$;

revoke all on function context_document_history(uuid, text, integer, integer) from public;
grant execute on function context_document_history(uuid, text, integer, integer) to service_role;
