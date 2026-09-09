create table skills (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  description   text not null,
  license       text,
  compatibility text,
  metadata      jsonb,
  allowed_tools text,
  content       text not null,
  created_by    uuid not null references users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid references users(id),
  removed_at    timestamptz
);

create unique index skills_workspace_name_active_idx
  on skills (workspace_id, name)
  where removed_at is null;

alter table skills enable row level security;

grant select, insert, update on table skills to service_role;
