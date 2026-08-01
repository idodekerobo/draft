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
    references teams(id, organization_id) on delete restrict,
  foreign key (inference_credential_id, id)
    references credentials(id, workspace_id) on delete restrict
);
