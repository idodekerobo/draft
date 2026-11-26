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
