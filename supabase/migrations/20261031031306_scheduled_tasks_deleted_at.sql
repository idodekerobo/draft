-- A deleted routine keeps its row, because sessions and errors still point at it.
alter table scheduled_tasks
  add column deleted_at timestamptz;
