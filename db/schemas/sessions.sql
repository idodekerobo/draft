create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  owner_user_id      uuid not null references users(id) on delete cascade,
  session_type       text not null default 'interactive'
                       check (session_type in ('interactive', 'routine')),
  harness            text not null default 'claude' check (harness in ('claude')),
  model              text,
  native_session_id  text,
  previous_session_id uuid references sessions(id) on delete set null,
  title              text,
  folder_name        text,
  git_remote         text,
  status             text not null default 'starting'
                       check (status in ('starting', 'live', 'host_offline', 'ended')),
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  end_reason         text,
  last_event_at      timestamptz,
  last_seen          timestamptz not null default now(),
  last_seq           bigint not null default 0,
  open_approval_count integer not null default 0,
  host_machine_id    text not null,
  host_name          text,
  harness_version    text,
  raw_storage_path   text,
  raw_uploaded_at    timestamptz,
  -- Routine sessions only. idempotency_key is '<task_id>:<occurrence_at>'.
  scheduled_task_id  uuid,
  idempotency_key    text,

  unique (id, workspace_id),
  foreign key (scheduled_task_id, workspace_id)
    references scheduled_tasks(id, workspace_id),
  check ((session_type = 'routine') = (scheduled_task_id is not null))
);

create index sessions_workspace_started_idx on sessions (workspace_id, started_at desc);
create index sessions_unfinished_last_seen_idx on sessions (last_seen)
  where status in ('starting', 'live');

create unique index sessions_idempotency_key_idx on sessions (workspace_id, idempotency_key)
  where idempotency_key is not null;
create index sessions_scheduled_task_idx on sessions (scheduled_task_id, started_at desc)
  where scheduled_task_id is not null;

alter table sessions enable row level security;

create policy sessions_select on sessions
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = sessions.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table sessions to authenticated;
grant select, insert, update on table sessions to service_role;
