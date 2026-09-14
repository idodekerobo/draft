alter table scheduled_tasks drop constraint scheduled_tasks_task_type_check;

alter table scheduled_tasks add constraint scheduled_tasks_task_type_check
  check (task_type in ('ingest_source', 'synthesize_workspace', 'rebuild_projection', 'summarize_sessions', 'slack_backfill'));
