-- Crash-resume state for embedded agents (Home): pi-durable's records and documents, and Draft's own claim, counter and outbox.
-- Three tables, grouped by job. Never a transcript: the transcript stays in session_events. Service role only.

-- Crash-resume state of an embedded agent (Home): pi-durable's conversations, entries, tasks and submissions.
-- One ID space per session, shared with embedded_agent_documents (ids come from the counter in embedded_agent_state).
-- This is never a transcript and the UI never reads it: the transcript is session_events. No secrets are stored here.
-- Service role only; RLS is on with no policy. Allowed values live in the code (backend/src/embedded-agent/pi).
-- record_type: conversation, entry, task, submission. status is a task's or a submission's. head is set on an entry that
-- ends a branch. commit_seq orders entries. The columns beside `record` exist for pi's indexed reads; `record` is pi's own row.
create table embedded_agent_records (
  session_id           uuid not null references sessions(id) on delete cascade,
  id                   bigint not null,
  record_type          text not null,
  conversation_id      bigint,
  owner_conversation_id bigint,
  owner_task_id        bigint,
  task_kind            text,
  status               text,
  abort_requested      boolean,
  background           boolean,
  request_id           text,
  head                 bigint,
  commit_seq           bigint,
  record               jsonb not null,

  primary key (session_id, id)
);

create index embedded_agent_entries_by_conversation_idx
  on embedded_agent_records (session_id, conversation_id, id desc) where record_type = 'entry';
create index embedded_agent_entry_heads_idx
  on embedded_agent_records (session_id, conversation_id, id desc) where record_type = 'entry' and head is not null;
create index embedded_agent_conversations_by_owner_idx
  on embedded_agent_records (session_id, owner_conversation_id, id) where record_type = 'conversation';
create index embedded_agent_tasks_by_status_idx
  on embedded_agent_records (session_id, status, id) where record_type = 'task';
create index embedded_agent_tasks_by_conversation_idx
  on embedded_agent_records (session_id, conversation_id, id) where record_type = 'task';
create index embedded_agent_submissions_by_status_idx
  on embedded_agent_records (session_id, status, id) where record_type = 'submission';
-- A request id is taken once per conversation: a repeat finds this row instead of starting new work.
create unique index embedded_agent_submissions_by_request_idx
  on embedded_agent_records (session_id, conversation_id, request_id) where record_type = 'submission' and request_id is not null;

alter table embedded_agent_records enable row level security;

grant select, insert, update, delete on table embedded_agent_records to service_role;

-- pi-durable's documents and their revisions, for an embedded agent (Home). Crash-resume state only: not a transcript, no secrets.
-- row_kind 'document': one row per document, seq 0. row_kind 'revision': one row per revision of document_id, with its seq
-- (rising), kind 'base' or 'delta', version and content in `record`. For a document row, kind is the document's kind.
-- Service role only; RLS is on with no policy. Allowed values live in the code (backend/src/embedded-agent/pi).
create table embedded_agent_documents (
  session_id     uuid not null references sessions(id) on delete cascade,
  document_id    bigint not null,
  row_kind       text not null,
  seq            integer not null default 0,
  kind           text not null,
  family         smallint,
  scope_kind     text,
  owner_id       bigint,
  key_value      text,
  version        integer,
  created_at_ms  bigint,
  retired_at     bigint,
  record         jsonb not null,

  primary key (session_id, document_id, row_kind, seq)
);

-- Finds a document by its address, newest first.
create index embedded_agent_documents_by_address_idx
  on embedded_agent_documents (session_id, kind, scope_kind, owner_id, family, key_value, created_at_ms desc, retired_at)
  where row_kind = 'document';
create index embedded_agent_documents_by_scope_idx
  on embedded_agent_documents (session_id, scope_kind, owner_id, document_id) where row_kind = 'document';
create index embedded_agent_documents_by_scope_kind_idx
  on embedded_agent_documents (session_id, scope_kind, owner_id, kind, document_id) where row_kind = 'document';
create index embedded_agent_revisions_by_kind_idx
  on embedded_agent_documents (session_id, document_id, kind, seq desc) where row_kind = 'revision';

alter table embedded_agent_documents enable row level security;

grant select, insert, update, delete on table embedded_agent_documents to service_role;

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

