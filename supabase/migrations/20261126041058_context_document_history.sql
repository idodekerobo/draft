-- Document history for synthesis: which versions changed a document, and when each document last changed.
-- Both read only the newest p_scan versions. The functions are also kept in db/functions/.

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

-- For each document in the latest version, the newest version that changed it, found in the newest
-- p_scan versions. A document that did not change in that window has no row: it is older than the window.
create or replace function context_documents_last_changed(
  p_workspace_id uuid,
  p_scan integer default 300
)
returns table (
  path text,
  version_id uuid,
  version_number bigint,
  created_at timestamptz,
  creation_reason text,
  agent_run_id uuid
)
language sql
security definer
set search_path = public
stable
as $$
  with window_versions as (
    select v.id, v.version_number, v.created_at, v.creation_reason, v.agent_run_id, v.documents_json,
           lead(v.documents_json) over (order by v.version_number desc) as older_documents,
           lead(v.version_number) over (order by v.version_number desc) as older_number
    from workspace_context_versions v
    where v.workspace_id = p_workspace_id
    order by v.version_number desc
    limit greatest(p_scan, 1) + 1
  ),
  latest as (
    select documents_json from window_versions order by version_number desc limit 1
  ),
  changes as (
    select w.id, w.version_number, w.created_at, w.creation_reason, w.agent_run_id, d.key as path
    from window_versions w, jsonb_each(w.documents_json) d
    where (w.older_number is not null or w.version_number = 1)
      and (d.value ->> 'sha256') is distinct from (w.older_documents -> d.key ->> 'sha256')
  )
  select distinct on (c.path) c.path, c.id, c.version_number, c.created_at, c.creation_reason, c.agent_run_id
  from changes c
  where c.path in (select jsonb_object_keys(documents_json) from latest)
  order by c.path, c.version_number desc;
$$;

revoke all on function context_documents_last_changed(uuid, integer) from public;
grant execute on function context_documents_last_changed(uuid, integer) to service_role;
