-- What Draft keeps beside an embedded agent's engine state (Home). Harness-neutral: nothing here is pi's.
-- kind 'counter':  key 'ids' holds the next record id and the next commit seq in payload.
-- kind 'claim':    key 'owner' holds { owner, epoch, expires_at }: which backend process drives this agent. Every commit
--                  checks the epoch in its own transaction, so a process that lost the claim cannot write.
-- kind 'outbox':   one row per committed reply, key = its source id, seq = its commit_seq. A projector copies it into
--                  session_events and sets projected_at in the same transaction. Not agent_event_inbox: unrelated.
-- kind 'computer': (slice 4b) key 'binding' holds the sandbox machine and volume. Its token is stored encrypted.
-- Crash-resume state only: never a transcript, never read by the UI, no secrets in the clear. Service role only; RLS is on
-- with no policy.
create table embedded_agent_state (
  session_id     uuid not null references sessions(id) on delete cascade,
  kind           text not null,
  key            text not null,
  seq            bigint not null default 0,
  payload        jsonb not null default '{}',
  projected_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  primary key (session_id, kind, key)
);

-- The projector reads unprojected outbox rows in commit order.
create index embedded_agent_outbox_pending_idx
  on embedded_agent_state (session_id, seq) where kind = 'outbox' and projected_at is null;

alter table embedded_agent_state enable row level security;

grant select, insert, update, delete on table embedded_agent_state to service_role;
