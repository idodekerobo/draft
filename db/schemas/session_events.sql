create table session_events (
  session_id    uuid not null,
  workspace_id  uuid not null,
  seq           bigint not null,
  source_id     text not null,
  kind          text not null check (kind in ('user_message', 'assistant_text', 'tool_use', 'tool_result', 'thinking', 'session_note')),
  payload       jsonb not null default '{}',
  created_at    timestamptz not null default now(),

  primary key (session_id, seq),
  unique (session_id, source_id),
  foreign key (session_id, workspace_id)
    references sessions(id, workspace_id) on delete cascade
);

alter table session_events enable row level security;

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

grant select on table session_events to authenticated;
grant select on table session_events to service_role;
