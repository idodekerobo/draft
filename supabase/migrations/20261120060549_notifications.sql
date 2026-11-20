-- One thing Draft tells a person, independent of channel. Each send on a channel is a notification_deliveries row.
create table notifications (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  recipient_person_id uuid not null,
  -- The human whose authority the send used (routine owner or caller). Null for system rows.
  sender_user_id      uuid references users(id) on delete set null,
  kind                text not null check (kind in ('message', 'todo_routed')),
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

-- One attempt to send a notification on one channel. The channel is checked in code, not here, so a new channel needs no
-- migration (people.notify_channels works the same way).
create table notification_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  notification_id     uuid not null,
  workspace_id        uuid not null,
  channel             text not null,
  -- sent: the provider accepted it. delivered: the recipient's mail server accepted it.
  status              text not null default 'queued'
                        check (status in ('queued', 'sent', 'delivered', 'delayed', 'bounced', 'complained', 'failed')),
  provider_message_id text,
  accepted_at         timestamptz,
  delivered_at        timestamptz,
  last_event_at       timestamptz,
  error_code          text,
  error_detail        text check (char_length(error_detail) <= 500),
  attempt_count       integer not null default 0 check (attempt_count >= 0),
  next_attempt_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (id, workspace_id),
  foreign key (notification_id, workspace_id)
    references notifications(id, workspace_id) on delete cascade
);

create unique index notification_deliveries_provider_message_idx
  on notification_deliveries (channel, provider_message_id) where provider_message_id is not null;
create index notification_deliveries_notification_idx on notification_deliveries (notification_id);
create index notification_deliveries_retry_idx on notification_deliveries (next_attempt_at) where status = 'queued';

create trigger notification_deliveries_set_updated_at
  before update on notification_deliveries
  for each row execute function set_updated_at();

alter table notifications enable row level security;
alter table notification_deliveries enable row level security;

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

-- Runs the parent's policy, so a delivery is readable exactly when its notification is.
create policy notification_deliveries_select on notification_deliveries
  for select to authenticated
  using (
    exists (
      select 1 from notifications n
      where n.id = notification_deliveries.notification_id
        and n.workspace_id = notification_deliveries.workspace_id
    )
  );

grant select on table notifications, notification_deliveries to authenticated;
grant select, insert on table notifications to service_role;
grant select, insert, update on table notification_deliveries to service_role;
