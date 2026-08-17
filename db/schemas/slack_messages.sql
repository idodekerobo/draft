-- Slack-specific structured data for a captured message: one row per
-- (source_connection, channel, message, revision). Capture is independent of
-- synthesis batching -- a message is written here the moment it's captured,
-- and source_item_id is filled in later (many-to-one) once a batch of this
-- channel's messages gets rolled up into a source_items row. This table
-- holds the shape needed to group threads and re-render channels without
-- re-fetching from Slack.
--
-- Slack gives no revision id, so message_version is the message's own `ts`
-- at first capture. Edits are detected and logged, not written as a new
-- revision, until edit handling is built.
create table slack_messages (
  id                           uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references workspaces(id) on delete cascade,
  source_connection_id        uuid not null,
  source_item_id                uuid,
  channel_id                  text not null,
  channel_name_snapshot        text,
  message_ts                   text not null,
  message_version               text not null,
  thread_ts                    text,
  parent_user_id                text,
  slack_user_id                  text,
  user_name_snapshot             text,
  text                            text,
  subtype                        text,
  is_deleted                     boolean not null default false,
  edited_at                      timestamptz,
  deleted_at                     timestamptz,
  blocks_json                    jsonb not null default '[]',
  files_json                     jsonb not null default '[]',
  reactions_json                  jsonb not null default '[]',
  provider_metadata_json          jsonb not null default '{}',
  captured_at                    timestamptz not null default now(),
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),

  unique (source_connection_id, channel_id, message_ts, message_version),
  foreign key (source_item_id, workspace_id)
    references source_items(id, workspace_id) on delete set null,
  foreign key (source_connection_id, workspace_id)
    references source_connections(id, workspace_id) on delete cascade
);

alter table slack_messages enable row level security;

create policy slack_messages_select on slack_messages
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = slack_messages.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table slack_messages to authenticated;
grant select, insert, update on table slack_messages to service_role;
