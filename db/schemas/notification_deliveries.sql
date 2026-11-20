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

alter table notification_deliveries enable row level security;

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

grant select on table notification_deliveries to authenticated;
grant select, insert, update on table notification_deliveries to service_role;
