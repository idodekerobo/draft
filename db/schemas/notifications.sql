-- One thing Draft tells a person, independent of channel. Each send on a channel is a notification_deliveries row.
-- Bodies are stored on the row. A private row is read by its recipient and its sender; a shared row by any member.
create table notifications (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  recipient_person_id uuid not null,
  -- The human whose authority the send used (routine owner or caller). Null for system rows.
  sender_user_id      uuid references users(id) on delete set null,
  kind                text not null
                        check (kind in ('message', 'todo_routed', 'run_result', 'connection_attention', 'identity_proposed', 'todo_reassign')),
  subject             text not null check (char_length(subject) between 1 and 200),
  body_text           text not null,
  body_html           text,
  link                text,
  -- private: only the recipient and the sender read it. shared: any member of the workspace.
  visibility          text not null default 'private' check (visibility in ('private', 'shared')),
  agent_run_id        uuid,
  scheduled_task_id   uuid,
  -- The same key with the same content_hash returns this row. The same key with another hash is refused.
  idempotency_key     text not null,
  content_hash        text not null,
  -- Home: a notification that needs the recipient to act stays open until done, not_mine or retracted (an undone Not mine's reassign card).
  needs_action        boolean not null default false,
  state               text not null default 'open' check (state in ('open', 'done', 'not_mine', 'retracted')),
  -- What the notification is about, such as a notification or an approval, and the identity match that routed a to-do.
  ref_type            text,
  ref_id              text,
  matched_identity_id uuid,
  seen_at             timestamptz,
  acted_at            timestamptz,
  created_at          timestamptz not null default now(),

  unique (id, workspace_id),
  unique (workspace_id, idempotency_key),
  foreign key (recipient_person_id, workspace_id)
    references people(id, workspace_id) on delete cascade,
  foreign key (agent_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete set null (agent_run_id),
  foreign key (scheduled_task_id, workspace_id)
    references scheduled_tasks(id, workspace_id) on delete set null (scheduled_task_id)
);

create index notifications_workspace_created_idx on notifications (workspace_id, created_at desc);
create index notifications_recipient_created_idx on notifications (recipient_person_id, created_at desc);
create index notifications_needs_action_idx on notifications (recipient_person_id)
  where needs_action and state = 'open';

alter table notifications enable row level security;

-- Members read shared rows, and the sender reads a private row. The recipient reads private rows through the backend
-- (service role): people has no select policy for authenticated users, so a join to it would return nothing here.
create policy notifications_select on notifications
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = notifications.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
    and (notifications.visibility = 'shared' or notifications.sender_user_id = auth.uid())
  );

grant select on table notifications to authenticated;
grant select, insert, update on table notifications to service_role;
