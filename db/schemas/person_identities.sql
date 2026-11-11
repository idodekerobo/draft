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
