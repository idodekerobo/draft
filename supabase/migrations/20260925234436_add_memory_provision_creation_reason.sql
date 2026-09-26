alter table workspace_context_versions drop constraint workspace_context_versions_creation_reason_check;

alter table workspace_context_versions add constraint workspace_context_versions_creation_reason_check
  check (creation_reason in ('seed', 'synthesis', 'manual_edit', 'restore', 'memory_provision'));
