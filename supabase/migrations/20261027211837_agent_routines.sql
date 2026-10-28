-- Agent routines: a scheduled agent run on Fly. Each run is a routine session.
alter table scheduled_tasks drop constraint scheduled_tasks_task_type_check;

alter table scheduled_tasks add constraint scheduled_tasks_task_type_check
  check (task_type in ('ingest_source', 'synthesize_workspace', 'rebuild_projection', 'summarize_sessions', 'slack_backfill', 'agent_routine'));

-- config_json holds the prompt, harness, model and title for an agent routine.
alter table scheduled_tasks
  add column created_by_user_id uuid references users(id) on delete set null;

alter table sessions
  add column scheduled_task_id uuid,
  add column idempotency_key text,
  add constraint sessions_scheduled_task_fkey
    foreign key (scheduled_task_id, workspace_id) references scheduled_tasks(id, workspace_id),
  add constraint sessions_routine_link_check
    check ((session_type = 'routine') = (scheduled_task_id is not null));

-- <task_id>:<occurrence_at>. A second dispatch of the same occurrence cannot insert a second session.
create unique index sessions_idempotency_key_idx on sessions (workspace_id, idempotency_key)
  where idempotency_key is not null;

create index sessions_scheduled_task_idx on sessions (scheduled_task_id, started_at desc)
  where scheduled_task_id is not null;

-- A routine session has no desktop host and sends no heartbeat. The scheduler tick fails it on a timeout instead.
create or replace function sweep_stale_sessions(p_stale_after interval default interval '60 seconds')
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update sessions
  set status = 'host_offline'
  where status in ('starting', 'live')
    and session_type = 'interactive'
    and last_seen < now() - p_stale_after;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
