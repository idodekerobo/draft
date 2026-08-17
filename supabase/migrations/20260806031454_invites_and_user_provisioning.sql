-- ---------------------------------------------------------------------------
-- Provision the public user row for every Supabase Auth signup
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, status, organization_role)
  values (new.id, new.email, 'invited', 'member')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger create_user_row_on_signup
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Reusable pilot invitations (service-role only)
-- ---------------------------------------------------------------------------
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  team_id uuid not null,
  token text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (team_id, organization_id)
    references public.teams(id, organization_id) on delete cascade
);

create trigger invites_set_updated_at
  before update on public.invites
  for each row execute function public.set_updated_at();

alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;
grant select, insert, update on public.invites to service_role;
