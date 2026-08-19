-- Agent session capture schema (plan 0045, Decisions 2 & 3).
--
-- session_contributors is the unauthenticated-identity tier, kept separate
-- from `users` on purpose: an unauthenticated `git config user.email` claim
-- is trivially spoofable, so it must never auto-link to a real Draft user.
-- Linking only ever happens server-side, via claimed_user_id, and never
-- retroactively authenticates anything (see plan 0045 Decision 2).
--
-- agent_sessions carries exactly one of user_id / contributor_id (XOR, not
-- OR) so "who captured this" is never ambiguous to a downstream consumer.
-- agent_messages holds raw transcript turns, immutable/append-only like
-- workspace_events, and is delete+reinsert per session on re-capture (the
-- source JSONL only grows).
--
-- No writers exist yet -- this migration only lands the schema. Capture,
-- ingestion, and summarization land in later slices of plan 0045.

-- ── session_contributors ────────────────────────────────────────────────
create table session_contributors (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references workspaces(id) on delete cascade,
  git_email         text not null,
  git_display_name  text,
  claimed_user_id   uuid references users(id) on delete set null,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),

  unique (workspace_id, git_email),
  unique (id, workspace_id)
);

alter table session_contributors enable row level security;

create policy session_contributors_select on session_contributors
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = session_contributors.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table session_contributors to authenticated;
grant select, insert, update on table session_contributors to service_role;

-- ── agent_sessions ──────────────────────────────────────────────────────
create table agent_sessions (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references workspaces(id) on delete cascade,
  provider              text not null,          -- claude-code | hermes | opencode | ...
  user_id               uuid references users(id),                 -- authenticated path
  contributor_id        uuid references session_contributors(id),  -- fallback path
  external_session_id   text not null,           -- provider's own session id
  project               text,
  cwd                   text,
  started_at            timestamptz not null,
  ended_at              timestamptz,
  status                text not null,
  -- Summarization lease + retry state (Decision 4b). An attempt timestamp
  -- alone is a lease with no expiry: a worker that dies mid-run would wedge
  -- the session forever without summary_lease_until.
  summary_status        text not null default 'pending'
                          check (summary_status in ('pending', 'leased', 'ok', 'failed', 'skipped')),
  summary_attempts      int not null default 0,
  summary_lease_until   timestamptz,
  summary_last_error    text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  check (num_nonnulls(user_id, contributor_id) = 1),
  foreign key (contributor_id, workspace_id)
    references session_contributors(id, workspace_id) on delete restrict,
  unique (workspace_id, provider, external_session_id),
  unique (id, workspace_id)
);

create trigger agent_sessions_set_updated_at
  before update on agent_sessions
  for each row execute function set_updated_at();

alter table agent_sessions enable row level security;

create policy agent_sessions_select on agent_sessions
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = agent_sessions.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table agent_sessions to authenticated;
grant select, insert, update on table agent_sessions to service_role;

-- ── agent_messages ──────────────────────────────────────────────────────
-- Immutable feed, no updated_at: the ingestion hook deletes and reinserts
-- the full message set for a session rather than mutating rows in place.
create table agent_messages (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  seq          int not null,
  role         text not null,
  content      text not null,
  created_at   timestamptz not null default now(),

  -- Composite FK, matching the pattern source_items already uses for its
  -- own workspace_id: keeps RLS a single-table predicate with no join,
  -- while making a message's workspace_id drift from its session's
  -- unrepresentable rather than merely unlikely.
  foreign key (session_id, workspace_id)
    references agent_sessions(id, workspace_id) on delete cascade
);

create index agent_messages_session_id_seq_idx on agent_messages (session_id, seq);

alter table agent_messages enable row level security;

create policy agent_messages_select on agent_messages
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = agent_messages.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table agent_messages to authenticated;
grant select, insert, delete on table agent_messages to service_role;
