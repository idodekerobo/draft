-- Tenancy foundation: organizations, teams, users, workspaces.

-- ── updated_at trigger ──────────────────────────────────────────────────

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ── organizations ────────────────────────────────────────────────────────

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  name        text not null,
  status      text not null default 'active'
                check (status in ('active', 'suspended', 'archived')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger organizations_set_updated_at
  before update on organizations
  for each row execute function set_updated_at();

-- ── teams ────────────────────────────────────────────────────────────────

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

create trigger teams_set_updated_at
  before update on teams
  for each row execute function set_updated_at();

-- ── users ────────────────────────────────────────────────────────────────

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

create trigger users_set_updated_at
  before update on users
  for each row execute function set_updated_at();

-- ── workspaces ───────────────────────────────────────────────────────────

create table workspaces (
  id                           uuid primary key default gen_random_uuid(),
  organization_id              uuid not null references organizations(id) on delete cascade,
  team_id                      uuid not null,
  slug                         text not null,
  name                         text not null,
  status                       text not null default 'active'
                                 check (status in ('active', 'archived')),
  access_mode                  text not null default 'team_default'
                                 check (access_mode in ('team_default', 'restricted')),
  current_context_version_id  uuid,
  inference_credential_id     uuid,
  runs_enabled                 boolean not null default true,
  max_runs_per_day             integer check (max_runs_per_day > 0),
  max_cost_usd_per_day         numeric(10, 2),
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now(),

  unique (team_id, slug),
  unique (id, organization_id),
  unique (id, team_id),
  foreign key (team_id, organization_id)
    references teams(id, organization_id) on delete restrict
);

create trigger workspaces_set_updated_at
  before update on workspaces
  for each row execute function set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────

create or replace function current_user_org_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select organization_id from public.users where id = auth.uid();
$$;

alter table organizations enable row level security;
alter table teams enable row level security;
alter table users enable row level security;
alter table workspaces enable row level security;

create policy organizations_select on organizations
  for select to authenticated
  using (id = current_user_org_id());

create policy teams_select on teams
  for select to authenticated
  using (organization_id = current_user_org_id());

create policy users_select on users
  for select to authenticated
  using (id = auth.uid() or organization_id = current_user_org_id());

create policy workspaces_select on workspaces
  for select to authenticated
  using (organization_id = current_user_org_id());
