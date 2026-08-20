-- Plan 0045 steps 3/4/6: session-ingest bearer tokens reuse `credentials`
-- (no new table — see plan doc). `credentials.provider` has no DB CHECK
-- constraint by design (db/schemas/credentials.sql); "claude_session_ingest"
-- is added to the TS CredentialProvider union only.

-- Replaces a session's full message set atomically: upsert the
-- agent_sessions row, then delete + reinsert agent_messages, all in one
-- transaction. Mirrors upsert_source_item.sql's shape (security definer,
-- search_path locked, row locking before mutation, revoked from public).
create or replace function replace_agent_session_messages(
  p_workspace_id uuid,
  p_provider text,
  p_external_session_id text,
  p_user_id uuid,
  p_contributor_id uuid,
  p_project text,
  p_cwd text,
  p_started_at timestamptz,
  p_ended_at timestamptz,
  p_status text,
  p_messages jsonb -- array of {role, content}, in order
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  -- Lock any existing row for this session up front, so a concurrent
  -- ingest of the same (workspace, provider, external_session_id) can't
  -- interleave its delete+reinsert with this one's.
  perform 1
  from agent_sessions
  where workspace_id = p_workspace_id
    and provider = p_provider
    and external_session_id = p_external_session_id
  for update;

  insert into agent_sessions (
    workspace_id, provider, external_session_id, user_id, contributor_id,
    project, cwd, started_at, ended_at, status
  ) values (
    p_workspace_id, p_provider, p_external_session_id, p_user_id, p_contributor_id,
    p_project, p_cwd, p_started_at, p_ended_at, p_status
  )
  on conflict (workspace_id, provider, external_session_id)
  do update set
    -- Attribution never regresses: a later contributor-tier ingest of a
    -- session first seen verified must not overwrite the verified user_id.
    user_id = coalesce(agent_sessions.user_id, excluded.user_id),
    contributor_id = case
      when agent_sessions.user_id is not null then null
      else excluded.contributor_id
    end,
    project = excluded.project,
    cwd = excluded.cwd,
    ended_at = excluded.ended_at,
    status = excluded.status
  returning id into v_session_id;

  delete from agent_messages where session_id = v_session_id;

  insert into agent_messages (session_id, workspace_id, seq, role, content)
  select
    v_session_id,
    p_workspace_id,
    ordinality - 1,
    msg->>'role',
    msg->>'content'
  from jsonb_array_elements(p_messages) with ordinality as t(msg, ordinality);

  return jsonb_build_object('session_id', v_session_id);
end;
$$;

revoke all on function replace_agent_session_messages(
  uuid, text, text, uuid, uuid, text, text, timestamptz, timestamptz, text, jsonb
) from public;
grant execute on function replace_agent_session_messages(
  uuid, text, text, uuid, uuid, text, text, timestamptz, timestamptz, text, jsonb
) to service_role;

-- Full-text search index (Decision 6) — index only; `sessions search` is
-- step 7, not built here.
create index if not exists source_items_content_markdown_gin_idx
  on source_items using gin (to_tsvector('english', content_markdown));
