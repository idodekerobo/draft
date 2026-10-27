create table session_inputs (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null,
  workspace_id    uuid not null,
  author_user_id  uuid not null references users(id) on delete cascade,
  author_name     text not null,
  kind            text not null
                    check (kind in ('message', 'permission_decision', 'stop', 'end')),
  payload         jsonb not null default '{}',
  state           text not null default 'queued'
                    check (state in ('queued', 'delivering', 'consumed', 'failed', 'uncertain')),
  -- Why a queued input waits, or why a failed input failed.
  reason          text,
  consumed_seq    bigint,
  dismissed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  foreign key (session_id, workspace_id)
    references sessions(id, workspace_id) on delete cascade
);

create index session_inputs_session_created_idx on session_inputs (session_id, created_at);

-- One winning decision per request. A failed decision does not count.
create unique index session_inputs_one_decision_idx
  on session_inputs (session_id, (payload->>'requestId'))
  where kind = 'permission_decision' and state <> 'failed';

alter table session_inputs enable row level security;

create policy session_inputs_select on session_inputs
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = session_inputs.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table session_inputs to authenticated;
grant select, update on table session_inputs to service_role;
