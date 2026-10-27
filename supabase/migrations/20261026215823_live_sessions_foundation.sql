-- Live agent sessions, slice 1: sessions, session_events, the append function,
-- the per-workspace flag and the errors changes.

alter table workspaces
  add column live_sessions_enabled boolean not null default false;

create table sessions (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  owner_user_id      uuid not null references users(id) on delete cascade,
  session_type       text not null default 'interactive'
                       check (session_type in ('interactive', 'routine')),
  harness            text not null default 'claude' check (harness in ('claude')),
  model              text,
  native_session_id  text,
  title              text,
  folder_name        text,
  git_remote         text,
  status             text not null default 'starting'
                       check (status in ('starting', 'live', 'host_offline', 'ended')),
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  end_reason         text,
  last_event_at      timestamptz,
  last_seq           bigint not null default 0,
  host_machine_id    text not null,
  host_name          text,

  unique (id, workspace_id)
);

create index sessions_workspace_started_idx on sessions (workspace_id, started_at desc);

create table session_events (
  session_id    uuid not null,
  workspace_id  uuid not null,
  seq           bigint not null,
  source_id     text not null,
  kind          text not null check (kind in ('user_message', 'assistant_text')),
  payload       jsonb not null default '{}',
  created_at    timestamptz not null default now(),

  primary key (session_id, seq),
  unique (session_id, source_id),
  foreign key (session_id, workspace_id)
    references sessions(id, workspace_id) on delete cascade
);

alter table sessions enable row level security;
alter table session_events enable row level security;

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

create policy session_events_select on session_events
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = session_events.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table sessions to authenticated;
grant select on table session_events to authenticated;
grant select, insert, update on table sessions to service_role;
grant select on table session_events to service_role;

alter table errors drop constraint errors_operation_check;
alter table errors add constraint errors_operation_check
  check (operation in ('ingestion', 'scheduling', 'queue', 'execution',
                       'validation', 'commit', 'projection', 'auth', 'read', 'session'));

alter table errors add column session_id uuid;
alter table errors add foreign key (session_id, workspace_id)
  references sessions(id, workspace_id) on delete cascade;

alter table errors drop constraint errors_unattributed_has_no_links;
alter table errors add constraint errors_unattributed_has_no_links check (
  workspace_id is not null
  or (source_connection_id is null and scheduled_task_id is null
      and synthesis_run_id is null and session_id is null)
);

-- Session status:
--   starting -> live -> ended
--   starting/live --no heartbeat for 60 s--> host_offline --same host heartbeat--> live
-- Idle is not stored. Writes for an ended session are rejected.
--
-- Appends a batch of events in order. Seq comes from the session's counter, so
-- it has no gaps. A duplicate source_id is skipped and does not use a seq.
create or replace function append_session_events(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_machine_id text,
  p_events jsonb -- array of {source_id, kind, payload}
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session sessions%rowtype;
  v_event jsonb;
  v_seq bigint;
  v_inserted integer := 0;
  v_count integer;
begin
  select * into v_session
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_session.status = 'ended' then
    raise exception 'session_ended';
  end if;
  if v_session.host_machine_id is distinct from p_host_machine_id then
    raise exception 'foreign_host';
  end if;

  v_seq := v_session.last_seq;

  for v_event in select * from jsonb_array_elements(p_events) loop
    insert into session_events (session_id, workspace_id, seq, source_id, kind, payload)
    values (
      p_session_id, p_workspace_id, v_seq + 1,
      v_event->>'source_id', v_event->>'kind', coalesce(v_event->'payload', '{}'::jsonb)
    )
    on conflict (session_id, source_id) do nothing;

    get diagnostics v_count = row_count;
    if v_count > 0 then
      v_seq := v_seq + 1;
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  if v_inserted > 0 then
    update sessions
    set last_seq = v_seq,
        last_event_at = now(),
        status = 'live'
    where id = p_session_id;
  end if;

  return jsonb_build_object('last_seq', v_seq, 'inserted', v_inserted);
end;
$$;

revoke all on function append_session_events(uuid, uuid, text, jsonb) from public;
grant execute on function append_session_events(uuid, uuid, text, jsonb) to service_role;
