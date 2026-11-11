-- A person Draft knows in one workspace: a teammate, with or without an account.
-- Users act; people are talked about and routed to. user_id links a person to the account that acts.
create table people (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  display_name       text not null,
  user_id            uuid references users(id) on delete set null,
  status             text not null default 'pending' check (status in ('pending', 'active', 'rejected')),
  affiliation        text not null default 'member' check (affiliation in ('member', 'external')),
  -- Channels used when a notify call names none. The code checks the values, so a new channel needs no migration.
  notify_channels    text[] not null default '{slack}',
  created_by         text not null check (created_by in ('connection', 'agent', 'user')),
  -- agent_runs.id when created_by = 'agent'.
  created_by_run_id  uuid,
  created_by_user_id uuid references users(id) on delete set null,
  -- { sourceItemId, quote }: why the person was added.
  evidence           jsonb not null default '{}',
  decided_by_user_id uuid references users(id) on delete set null,
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  unique (id, workspace_id),
  unique (workspace_id, user_id),
  -- "set null (column)" keeps workspace_id, which is part of this key.
  foreign key (created_by_run_id, workspace_id)
    references agent_runs(id, workspace_id) on delete set null (created_by_run_id)
);

create index people_workspace_status_idx on people (workspace_id, status);

create trigger people_set_updated_at
  before update on people
  for each row execute function set_updated_at();

alter table people enable row level security;
grant select, insert, update, delete on table people to service_role;

-- One row per way to reach or recognise a person. unique (workspace_id, provider, external_id)
-- makes "this Slack user is exactly one person" a database rule.
create table person_identities (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null,
  person_id            uuid not null,
  provider             text not null check (provider in ('email', 'slack', 'linear', 'github', 'whatsapp')),
  -- A stable id: lowercased email, Slack U..., Linear user id, GitHub numeric id, E.164 phone.
  external_id          text not null,
  -- For display only. Handles change.
  handle               text,
  status               text not null check (status in ('confirmed', 'from_connection', 'inferred')),
  source_connection_id uuid,
  evidence             jsonb not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  unique (workspace_id, provider, external_id),
  foreign key (person_id, workspace_id)
    references people(id, workspace_id) on delete cascade,
  foreign key (source_connection_id, workspace_id)
    references source_connections(id, workspace_id) on delete set null (source_connection_id)
);

create index person_identities_workspace_person_idx on person_identities (workspace_id, person_id);

create trigger person_identities_set_updated_at
  before update on person_identities
  for each row execute function set_updated_at();

alter table person_identities enable row level security;
grant select, insert, update, delete on table person_identities to service_role;

-- The user whose connections and context a run may use. The actor is always the run itself, so only
-- the user it acts for is stored. Replaces agent_runs.principal, which a later migration drops.
alter table agent_runs add column on_behalf_of_user_id uuid references users(id) on delete set null;
