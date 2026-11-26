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
