create table teams (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  slug             text not null,
  name             text not null,
  status           text not null default 'active'
                     check (status in ('active', 'archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  unique (organization_id, slug),
  unique (id, organization_id)
);
