-- Allow errors that belong to no workspace (e.g. a capture hook with an invalid
-- ingest token). The authenticated select policy matches on workspace_id, so
-- these rows are readable only through the service role.
alter table errors alter column workspace_id drop not null;

-- The composite foreign keys use MATCH SIMPLE, so they skip the check when
-- workspace_id is null. Without this, a workspace-less row could point at
-- another workspace's connection, task or run.
alter table errors add constraint errors_unattributed_has_no_links
  check (
    workspace_id is not null
    or (source_connection_id is null and scheduled_task_id is null and synthesis_run_id is null)
  );
