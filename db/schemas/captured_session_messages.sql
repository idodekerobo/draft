-- Immutable feed, no updated_at: the ingestion hook deletes and reinserts
-- the full message set for a session rather than mutating rows in place.
create table captured_session_messages (
  id           uuid primary key default gen_random_uuid(),
  captured_session_id uuid not null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  seq          int not null,
  role         text not null,
  content      text not null,
  created_at   timestamptz not null default now(),

  -- Composite FK, matching the pattern source_items already uses for its
  -- own workspace_id: keeps RLS a single-table predicate with no join,
  -- while making a message's workspace_id drift from its session's
  -- unrepresentable rather than merely unlikely.
  foreign key (captured_session_id, workspace_id)
    references captured_sessions(id, workspace_id) on delete cascade
);

create index captured_session_messages_session_seq_idx on captured_session_messages (captured_session_id, seq);

alter table captured_session_messages enable row level security;

create policy captured_session_messages_select on captured_session_messages
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = captured_session_messages.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table captured_session_messages to authenticated;
grant select, insert, delete on table captured_session_messages to service_role;
