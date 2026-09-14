-- Replaces a session's full message set atomically: upsert the
-- agent_sessions row, then delete + reinsert agent_messages, all in one
-- transaction. Mirrors upsert_source_item.sql's shape (security definer,
-- search_path locked, row locking before mutation, revoked from public).
-- Attribution never regresses on re-ingest: once a session is linked to a
-- verified user_id, a later contributor-tier ingest of the same
-- (workspace, provider, external_session_id) cannot overwrite it back to
-- contributor_id.
-- p_session_project_id is set only when the ingesting
-- credential is project-scoped; a legacy credential's ingest passes null
-- and never overwrites an existing session_project_id (coalesce, not
-- excluded-wins) -- no backfill for legacy-authored sessions.
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
  p_messages jsonb, -- array of {role, content}, in order
  p_session_project_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_id uuid;
  v_transcript_revision bigint;
begin
  perform 1
  from agent_sessions
  where workspace_id = p_workspace_id
    and provider = p_provider
    and external_session_id = p_external_session_id
  for update;

  insert into agent_sessions (
    workspace_id, provider, external_session_id, user_id, contributor_id,
    project, cwd, started_at, ended_at, status, session_project_id
  ) values (
    p_workspace_id, p_provider, p_external_session_id, p_user_id, p_contributor_id,
    p_project, p_cwd, p_started_at, p_ended_at, p_status, p_session_project_id
  )
  on conflict (workspace_id, provider, external_session_id)
  do update set
    user_id = coalesce(agent_sessions.user_id, excluded.user_id),
    contributor_id = case
      when agent_sessions.user_id is not null then null
      else excluded.contributor_id
    end,
    project = excluded.project,
    cwd = excluded.cwd,
    ended_at = excluded.ended_at,
    status = excluded.status,
    session_project_id = coalesce(excluded.session_project_id, agent_sessions.session_project_id),
    transcript_revision = agent_sessions.transcript_revision + 1
  returning id, transcript_revision into v_session_id, v_transcript_revision;

  delete from agent_messages where session_id = v_session_id;

  insert into agent_messages (session_id, workspace_id, seq, role, content)
  select
    v_session_id,
    p_workspace_id,
    ordinality - 1,
    msg->>'role',
    msg->>'content'
  from jsonb_array_elements(p_messages) with ordinality as t(msg, ordinality);

  return jsonb_build_object(
    'session_id', v_session_id,
    'transcript_revision', v_transcript_revision
  );
end;
$$;

revoke all on function replace_agent_session_messages(
  uuid, text, text, uuid, uuid, text, text, timestamptz, timestamptz, text, jsonb, uuid
) from public;
grant execute on function replace_agent_session_messages(
  uuid, text, text, uuid, uuid, text, text, timestamptz, timestamptz, text, jsonb, uuid
) to service_role;
