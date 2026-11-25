create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  owner_user_id      uuid not null references users(id) on delete cascade,
  session_type       text not null default 'interactive'
                       check (session_type in ('interactive', 'routine')),
  harness            text not null default 'claude',
  model              text,
  -- Plain text such as 'low' or 'xhigh'; null means the harness's own setting. Allowed values depend on the model (core/src/harnesses).
  reasoning_effort   text,
  native_session_id  text,
  previous_session_id uuid references sessions(id) on delete set null,
  title              text,
  folder_name        text,
  git_remote         text,
  -- sleeping: a cloud session with no run in progress. A new run wakes it.
  status             text not null default 'starting'
                       check (status in ('starting', 'live', 'host_offline', 'sleeping', 'ended')),
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  end_reason         text,
  resume_request_id  uuid,
  last_failure       jsonb,
  last_event_at      timestamptz,
  last_seen          timestamptz not null default now(),
  last_seq           bigint not null default 0,
  open_approval_count integer not null default 0,
  host_id            text not null,
  host_name          text,
  harness_version    text,
  -- Claude: default, acceptEdits, plan, auto (and launch-only bypassPermissions, dontAsk). Codex: default, plan.
  permission_mode    text
                       check (permission_mode in ('default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk')),
  -- Codex only.
  approval_mode      text
                       check (approval_mode in ('ask-for-approval', 'approve-for-me', 'full-access')),
  -- Replaced by execution_target. Nullable and unused by new code; the contract step drops it.
  runtime            text
                       check (runtime in ('local', 'cloud')),
  -- Where the session runs: host (an already-registered host, "This computer"), sandbox (a Draft sandbox, "Draft Cloud")
  -- or backend. Checked in code. Nullable until the contract step.
  execution_target   text,
  -- The adapter that runs the harness, such as 'claude-terminal' or 'codex-exec' (core/src/harnesses). Checked in code.
  -- Nullable until the contract step.
  adapter_id         text,
  -- Cloud only: the sandbox volume's provider reference, and the seed the sandbox starts from.
  sandbox_volume     jsonb,
  seed               jsonb,
  raw_storage_path   text,
  raw_uploaded_at    timestamptz,
  -- Routine sessions only. idempotency_key is '<task>:<kind>:<agent_event id>', kind = timer, manual or an event name.
  scheduled_task_id  uuid,
  idempotency_key    text,
  -- Soft delete by the owner. A deleted session is ended too, and no viewer query returns it.
  deleted_at         timestamptz,
  -- Runs with the same key are serialized: one live run per (routine, key). Null for skipped runs.
  concurrency_key    text,

  unique (id, workspace_id),
  constraint sessions_scheduled_task_fkey
    foreign key (scheduled_task_id, workspace_id)
    references scheduled_tasks(id, workspace_id),
  constraint sessions_routine_link_check
    check ((session_type = 'routine') = (scheduled_task_id is not null))
);

create index sessions_workspace_started_idx on sessions (workspace_id, started_at desc);
create index sessions_unfinished_last_seen_idx on sessions (last_seen)
  where status in ('starting', 'live');

create unique index sessions_idempotency_key_idx on sessions (workspace_id, idempotency_key)
  where idempotency_key is not null;
create unique index sessions_one_live_per_key_idx on sessions (scheduled_task_id, concurrency_key)
  where concurrency_key is not null and status in ('starting', 'live', 'host_offline');
create index sessions_scheduled_task_idx on sessions (scheduled_task_id, started_at desc)
  where scheduled_task_id is not null;

alter table sessions enable row level security;

create policy sessions_select on sessions
  for select to authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from workspaces w
      where w.id = sessions.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table sessions to authenticated;
grant select, insert, update on table sessions to service_role;

-- Signals for changes a viewer can see; heartbeats and appends are left out (see db/functions/signal_session_row.sql).
create trigger sessions_signal_update
  after update on sessions
  for each row
  when (
    old.status is distinct from new.status
    or old.title is distinct from new.title
    or old.model is distinct from new.model
    or old.reasoning_effort is distinct from new.reasoning_effort
    or old.permission_mode is distinct from new.permission_mode
    or old.approval_mode is distinct from new.approval_mode
    or old.open_approval_count is distinct from new.open_approval_count
    or old.end_reason is distinct from new.end_reason
    or old.host_name is distinct from new.host_name
    or old.deleted_at is distinct from new.deleted_at
  )
  execute function signal_session_row();

create trigger sessions_signal_insert
  after insert on sessions
  for each row execute function signal_session_insert();
