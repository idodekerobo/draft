create table users (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text not null unique,
  display_name        text,
  organization_id     uuid references organizations(id) on delete restrict,
  primary_team_id     uuid,
  organization_role   text not null default 'member'
                         check (organization_role in ('owner', 'admin', 'member')),
  status              text not null default 'invited'
                         check (status in ('invited', 'active', 'disabled')),
  last_seen_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  foreign key (primary_team_id, organization_id)
    references teams(id, organization_id) on delete restrict
);

create or replace function current_user_org_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select organization_id from public.users where id = auth.uid();
$$;
