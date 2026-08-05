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

alter table users enable row level security;

create policy users_select on users
  for select to authenticated
  using (
    organization_id = current_user_org_id()
    and primary_team_id = current_user_team_id()
  );

grant select on table users to authenticated;

create or replace function current_user_org_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select organization_id from public.users where id = auth.uid();
$$;

create or replace function sync_user_email()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users set email = new.email where id = new.id;
  return new;
end;
$$;

create trigger sync_user_email_on_auth_update
  after update of email on auth.users
  for each row
  when (old.email is distinct from new.email)
  execute function sync_user_email();
