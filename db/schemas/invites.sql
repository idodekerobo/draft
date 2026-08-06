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

create trigger invites_set_updated_at before update on public.invites
for each row execute function public.set_updated_at();

alter table public.invites enable row level security;
revoke all on public.invites from anon, authenticated;
grant select, insert, update on public.invites to service_role;
