create table organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  status      text not null default 'active'
                check (status in ('active', 'suspended', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
