create table organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  status      text not null default 'active'
                check (status in ('active', 'suspended', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table organizations enable row level security;

create policy organizations_select on organizations
  for select to authenticated
  using (id = current_user_org_id());

grant select on table organizations to authenticated;
