-- Rollback for supabase/migrations/20261118200405_naming_refactor.sql.
-- This file is not in supabase/migrations, so it never applies on its own.
-- Use it only when the backend deploy fails and the old names must come back:
-- run `supabase migration new <short_name>`, copy this SQL into the new file, and
-- test it on staging before prod.
--
-- Not reversible:
-- - The synthesis_runs and synthesis_run_source_items tables stay dropped, and so do
--   the synthesis_run_id columns and the workspace_context_versions index.
-- - agent_runs.principal comes back with its default on every row. The old values are gone.
-- - connection_requests_provider_check may be added NOT VALID (see section 2).

begin;

-- 1. Constraint, index, trigger and policy names. The tables still have their new names here.
alter table captured_session_messages rename constraint captured_session_messages_pkey to agent_messages_pkey;
alter table captured_session_messages rename constraint captured_session_messages_session_id_workspace_id_fkey to agent_messages_session_id_workspace_id_fkey;
alter table captured_session_messages rename constraint captured_session_messages_workspace_id_fkey to agent_messages_workspace_id_fkey;
alter table captured_sessions rename constraint captured_sessions_check to agent_sessions_check;
alter table captured_sessions rename constraint captured_sessions_contributor_id_fkey to agent_sessions_contributor_id_fkey;
alter table captured_sessions rename constraint captured_sessions_contributor_id_workspace_id_fkey to agent_sessions_contributor_id_workspace_id_fkey;
alter table captured_sessions rename constraint captured_sessions_id_workspace_id_key to agent_sessions_id_workspace_id_key;
alter table captured_sessions rename constraint captured_sessions_pkey to agent_sessions_pkey;
alter table captured_sessions rename constraint captured_sessions_session_project_workspace_fk to agent_sessions_session_project_workspace_fk;
alter table captured_sessions rename constraint captured_sessions_summary_agent_run_fkey to agent_sessions_summary_agent_run_fkey;
alter table captured_sessions rename constraint captured_sessions_summary_status_check to agent_sessions_summary_status_check;
alter table captured_sessions rename constraint captured_sessions_transcript_revision_check to agent_sessions_transcript_revision_check;
alter table captured_sessions rename constraint captured_sessions_user_id_fkey to agent_sessions_user_id_fkey;
alter table captured_sessions rename constraint captured_sessions_workspace_id_fkey to agent_sessions_workspace_id_fkey;
alter table captured_sessions rename constraint captured_sessions_workspace_id_provider_external_session_id_key to agent_sessions_workspace_id_provider_external_session_id_key;
alter table errors rename constraint errors_connection_id_workspace_id_fkey to errors_source_connection_id_workspace_id_fkey;
alter table person_identities rename constraint person_identities_connection_id_workspace_id_fkey to person_identities_source_connection_id_workspace_id_fkey;
alter table scheduled_tasks rename constraint scheduled_tasks_connection_id_workspace_id_fkey to scheduled_tasks_source_connection_id_workspace_id_fkey;
alter table slack_messages rename constraint slack_messages_connection_id_channel_id_message_ts_m_key to slack_messages_source_connection_id_channel_id_message_ts_m_key;
alter table slack_messages rename constraint slack_messages_connection_id_workspace_id_fkey to slack_messages_source_connection_id_workspace_id_fkey;
alter table connections rename constraint connections_connected_by_user_id_fkey to source_connections_connected_by_user_id_fkey;
alter table connections rename constraint connections_credential_id_workspace_id_fkey to source_connections_credential_id_workspace_id_fkey;
alter table connections rename constraint connections_id_workspace_id_key to source_connections_id_workspace_id_key;
alter table connections rename constraint connections_pkey to source_connections_pkey;
alter table connections rename constraint connections_provider_check to source_connections_provider_check;
alter table connections rename constraint connections_status_check to source_connections_status_check;
alter table connections rename constraint connections_workspace_id_fkey to source_connections_workspace_id_fkey;
alter table connections rename constraint connections_workspace_id_provider_connection_key_key to source_connections_workspace_id_provider_connection_key_key;
alter table source_items rename constraint source_items_captured_session_workspace_fkey to source_items_agent_session_workspace_fkey;
alter table source_items rename constraint source_items_connection_id_external_id_external_vers_key to source_items_source_connection_id_external_id_external_vers_key;
alter table source_items rename constraint source_items_connection_id_workspace_id_fkey to source_items_source_connection_id_workspace_id_fkey;
alter table workspace_events rename constraint workspace_events_connection_id_workspace_id_fkey to workspace_events_source_connection_id_workspace_id_fkey;

alter index captured_session_messages_session_seq_idx rename to agent_messages_session_id_seq_idx;
alter index captured_sessions_summary_agent_run_idx rename to agent_sessions_summary_agent_run_idx;
alter index connections_github_installation_unique rename to source_connections_github_installation_unique;
alter index connections_granola_one_workspace_key rename to source_connections_granola_one_workspace_key;
alter index connections_granola_personal_per_user rename to source_connections_granola_personal_per_user;
alter index connections_one_live_github_per_workspace rename to source_connections_one_live_github_per_workspace;
alter index connections_one_live_singleton_per_workspace rename to source_connections_one_live_singleton_per_workspace;
alter index connections_one_per_connecting_user rename to source_connections_one_per_connecting_user;
alter index source_items_captured_session_idx rename to source_items_agent_session_idx;

alter trigger captured_sessions_set_updated_at on captured_sessions rename to agent_sessions_set_updated_at;
alter trigger connections_set_updated_at on connections rename to source_connections_set_updated_at;

alter policy captured_sessions_select on captured_sessions rename to agent_sessions_select;
alter policy captured_session_messages_select on captured_session_messages rename to agent_messages_select;
alter policy connections_select on connections rename to source_connections_select;

-- 2. connection_requests: the provider list from before the up migration.
-- codex_session, manual_upload and mcp are not in the old list. If a row uses one,
-- the constraint is added NOT VALID: it checks new writes, not existing rows.
alter table connection_requests drop constraint if exists connection_requests_provider_check;
do $$
begin
  if exists (
    select 1 from connection_requests
    where provider not in ('github', 'slack', 'linear', 'fireflies', 'granola', 'claude_session')
  ) then
    alter table connection_requests add constraint connection_requests_provider_check
      check (provider in ('github', 'slack', 'linear', 'fireflies', 'granola', 'claude_session')) not valid;
  else
    alter table connection_requests add constraint connection_requests_provider_check
      check (provider in ('github', 'slack', 'linear', 'fireflies', 'granola', 'claude_session'));
  end if;
end $$;

-- 3. agent_runs.principal. Its values were dropped by the up migration, so each row gets the default.
alter table agent_runs add column principal jsonb not null default '{"type": "workspace"}';

-- 4. Column names.
alter table captured_session_messages rename column captured_session_id to session_id;
alter table source_items rename column captured_session_id to agent_session_id;
alter table errors rename column connection_id to source_connection_id;
alter table person_identities rename column connection_id to source_connection_id;
alter table scheduled_tasks rename column connection_id to source_connection_id;
alter table slack_messages rename column connection_id to source_connection_id;
alter table source_items rename column connection_id to source_connection_id;
alter table workspace_events rename column connection_id to source_connection_id;
alter table sessions rename column host_id to host_machine_id;

-- 5. errors check with source_connection_id. The synthesis_run_id clause is gone with its column.
alter table errors drop constraint if exists errors_unattributed_has_no_links;
alter table errors add constraint errors_unattributed_has_no_links check (
  workspace_id is not null
  or (source_connection_id is null and scheduled_task_id is null and agent_run_id is null and session_id is null)
);

-- 6. Table names.
alter table captured_sessions rename to agent_sessions;
alter table captured_session_messages rename to agent_messages;
alter table connections rename to source_connections;

-- 7. Functions. A function that the up migration dropped is dropped again, then created with its pre-refactor body.
-- The others are replaced in place.
-- search_source_items
-- Body from the last pre-refactor migration. The db/functions snapshot is out of date for this function.
drop function if exists search_source_items(uuid, text, timestamptz, text, uuid, uuid, int, int, uuid);
create or replace function search_source_items(
  p_workspace_id uuid,
  p_query text,
  p_since timestamptz default null,
  p_provider text default null,
  p_user_id uuid default null,
  p_contributor_id uuid default null,
  p_limit int default 20,
  p_offset int default 0,
  p_caller_user_id uuid default null
)
returns table (
  source_item_id uuid,
  agent_session_id uuid,
  provider text,
  user_id uuid,
  contributor_id uuid,
  occurred_at timestamptz,
  snippet text
)
language sql
security definer
set search_path = public
stable
as $$
  select si.id, si.agent_session_id, si.metadata_json->>'provider',
    (si.metadata_json->>'user_id')::uuid, (si.metadata_json->>'contributor_id')::uuid,
    si.occurred_at,
    ts_headline('english', si.content_markdown, websearch_to_tsquery('english', p_query),
      'MaxFragments=2, MaxWords=35, MinWords=15')
  from source_items si
  where si.workspace_id = p_workspace_id
    and si.item_type = 'coding_session'
    and si.lifecycle_status = 'active'
    and (si.visibility = 'shared' or si.owner_user_id = p_caller_user_id)
    and to_tsvector('english', si.content_markdown) @@ websearch_to_tsquery('english', p_query)
    and (p_since is null or si.occurred_at >= p_since)
    and (p_provider is null or si.metadata_json->>'provider' = p_provider)
    and (p_user_id is null or (si.metadata_json->>'user_id')::uuid = p_user_id)
    and (p_contributor_id is null or (si.metadata_json->>'contributor_id')::uuid = p_contributor_id)
  order by si.occurred_at desc
  limit p_limit offset p_offset;
$$;

revoke all on function search_source_items(uuid, text, timestamptz, text, uuid, uuid, int, int, uuid) from public;
grant execute on function search_source_items(uuid, text, timestamptz, text, uuid, uuid, int, int, uuid) to service_role;

-- search_sources
drop function if exists search_sources(uuid, uuid, text, text, text[], timestamptz, timestamptz, real, timestamptz, uuid, int, text[]);
create or replace function search_sources(
  p_workspace_id uuid,
  p_caller_user_id uuid,
  p_query text default null,
  p_provider text default null,
  p_types text[] default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_after_rank real default null,
  p_after_occurred_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 11,
  p_person_terms text[] default null
)
returns table (
  source_item_id uuid,
  source_version text,
  title text,
  provider text,
  item_type text,
  representation_kind text,
  occurred_at timestamptz,
  source_time_start timestamptz,
  source_time_end timestamptz,
  metadata_json jsonb,
  content_markdown text,
  sanitized_raw_json jsonb,
  agent_session_id uuid,
  excerpt text,
  rank real
)
language sql
security definer
set search_path = public
stable
as $$
  -- ts_headline is comparatively expensive (it re-scans and highlights the
  -- full document), so it's computed only for the page actually returned,
  -- after ranking/keyset-filtering/limiting have already cut the candidate
  -- set down -- ts_rank_cd still has to run over every matching row, since
  -- correct ordering depends on it.
  with ranked as (
    select
      si.id,
      si.external_version,
      coalesce(si.metadata_json->>'title', si.metadata_json->>'project') as title,
      sc.provider,
      si.item_type,
      si.representation_kind,
      si.occurred_at,
      si.source_time_start,
      si.source_time_end,
      si.metadata_json,
      si.content_markdown,
      si.sanitized_raw_json,
      si.agent_session_id,
      (case when p_query is null then 0 else ts_rank_cd(
        to_tsvector('english', coalesce(si.content_markdown, '')),
        websearch_to_tsquery('english', p_query)
      ) end)::real as rank
    from source_items si
    join source_connections sc
      on sc.id = si.source_connection_id
     and sc.workspace_id = si.workspace_id
    where si.workspace_id = p_workspace_id
      and si.lifecycle_status = 'active'
      and (si.visibility = 'shared' or si.owner_user_id = p_caller_user_id)
      and (p_provider is null or sc.provider = p_provider)
      and (p_types is null or si.item_type = any(p_types))
      and (p_since is null or coalesce(si.source_time_end, si.source_time_start, si.occurred_at) >= p_since)
      and (p_until is null or coalesce(si.source_time_start, si.source_time_end, si.occurred_at) < p_until)
      and (p_query is null or to_tsvector('english', coalesce(si.content_markdown, ''))
        @@ websearch_to_tsquery('english', p_query))
      -- A person's identity ids (email, Slack, Linear...) as whole words in the text or the metadata.
      and (p_person_terms is null or exists (
        select 1
        from unnest(p_person_terms) as term
        where coalesce(si.content_markdown, '') || ' ' || si.metadata_json::text
          ~* ('\m' || regexp_replace(term, '([\\.^$|()\[\]{}*+?])', '\\\1', 'g') || '\M')
      ))
  ),
  paged as (
    select r.*
    from ranked r
    where p_after_rank is null
       or r.rank < p_after_rank
       or (r.rank = p_after_rank and r.occurred_at < p_after_occurred_at)
       or (r.rank = p_after_rank and r.occurred_at = p_after_occurred_at and r.id > p_after_id)
    order by r.rank desc, r.occurred_at desc, r.id asc
    limit greatest(1, least(p_limit, 101))
  )
  select
    p.id,
    p.external_version,
    p.title,
    p.provider,
    p.item_type,
    p.representation_kind,
    p.occurred_at,
    p.source_time_start,
    p.source_time_end,
    p.metadata_json,
    p.content_markdown,
    p.sanitized_raw_json,
    p.agent_session_id,
    (case when p_query is null then left(coalesce(p.content_markdown, ''), 400) else ts_headline(
      'english', coalesce(p.content_markdown, ''), websearch_to_tsquery('english', p_query),
      'MaxFragments=2, MaxWords=35, MinWords=15, StartSel=**, StopSel=**'
    ) end) as excerpt,
    p.rank
  from paged p
  order by p.rank desc, p.occurred_at desc, p.id asc;
$$;

revoke all on function search_sources(uuid, uuid, text, text, text[], timestamptz, timestamptz, real, timestamptz, uuid, int, text[]) from public;
grant execute on function search_sources(uuid, uuid, text, text, text[], timestamptz, timestamptz, real, timestamptz, uuid, int, text[]) to service_role;

-- upsert_source_item
drop function if exists upsert_source_item(uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid, text, timestamptz, timestamptz, uuid);
-- Locks the exact-match row (if any) and every prior active revision of
-- the same external_id before writing, so a crash or race between finding
-- prior revisions and superseding them can never leave two 'ready' rows for
-- one external_id. Supersedes all matched prior rows and links
-- supersedes_source_item_id to the most recently normalized one.
create or replace function upsert_source_item(
  p_workspace_id uuid,
  p_source_connection_id uuid,
  p_item_type text,
  p_external_id text,
  p_external_version text,
  p_occurred_at timestamptz,
  p_content_markdown text,
  p_content_hash text,
  p_metadata_json jsonb default '{}'::jsonb,
  p_sanitized_raw_json jsonb default null,
  p_lifecycle_status text default 'active',
  p_visibility text default 'shared',
  p_owner_user_id uuid default null,
  p_representation_kind text default 'unknown',
  p_source_time_start timestamptz default null,
  p_source_time_end timestamptz default null,
  p_agent_session_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_status text;
  v_existing_hash text;
  v_prior_ids uuid[];
  v_supersede_id uuid;
  v_item_id uuid;
  v_changed boolean;
  v_now timestamptz := now();
begin
  -- Connection is always the first row lock in lifecycle writes. This makes
  -- an in-flight ingest and disconnect serialize: whichever takes this lock
  -- first is the operation that truthfully completes first.
  select status into v_connection_status
  from source_connections
  where id = p_source_connection_id
    and workspace_id = p_workspace_id
  for update;

  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using
      errcode = 'P0001',
      message = 'connection_inactive';
  end if;

  -- Lock the exact-match row (same connection/external_id/external_version)
  -- if one already exists, so two concurrent writers of the identical
  -- revision can't race each other.
  select content_hash into v_existing_hash
  from source_items
  where source_connection_id = p_source_connection_id
    and external_id = p_external_id
    and external_version = p_external_version
  for update;

  v_changed := v_existing_hash is distinct from p_content_hash;

  -- Lock every prior active revision of this logical item before deciding
  -- anything else, so a concurrent caller can never observe -- or leave
  -- behind -- two 'ready' rows for the same external_id. Postgres rejects
  -- FOR UPDATE combined directly with an aggregate, so the lock happens in
  -- a CTE and array_agg runs over the already-locked rows outside it.
  with locked as (
    select id, normalized_at, created_at
    from source_items
    where source_connection_id = p_source_connection_id
      and external_id = p_external_id
      and lifecycle_status = 'active'
      and external_version <> p_external_version
    for update
  )
  select array_agg(id order by normalized_at desc nulls last, created_at desc)
    into v_prior_ids
  from locked;

  v_supersede_id := v_prior_ids[1];

  insert into source_items (
    workspace_id, source_connection_id, item_type, external_id,
    external_version, lifecycle_status, representation_kind, occurred_at,
    source_time_start, source_time_end, normalized_at, content_markdown,
    content_hash, metadata_json, sanitized_raw_json, supersedes_source_item_id,
    visibility, owner_user_id, agent_session_id
  ) values (
    p_workspace_id, p_source_connection_id, p_item_type, p_external_id,
    p_external_version, p_lifecycle_status, p_representation_kind, p_occurred_at,
    p_source_time_start, p_source_time_end, v_now, p_content_markdown,
    p_content_hash, p_metadata_json, p_sanitized_raw_json, v_supersede_id,
    p_visibility, p_owner_user_id, p_agent_session_id
  )
  on conflict (source_connection_id, external_id, external_version)
  do update set
    item_type = excluded.item_type,
    lifecycle_status = excluded.lifecycle_status,
    representation_kind = excluded.representation_kind,
    occurred_at = excluded.occurred_at,
    source_time_start = excluded.source_time_start,
    source_time_end = excluded.source_time_end,
    normalized_at = excluded.normalized_at,
    content_markdown = excluded.content_markdown,
    content_hash = excluded.content_hash,
    metadata_json = excluded.metadata_json,
    sanitized_raw_json = excluded.sanitized_raw_json,
    supersedes_source_item_id =
      coalesce(source_items.supersedes_source_item_id, excluded.supersedes_source_item_id),
    visibility = excluded.visibility,
    owner_user_id = excluded.owner_user_id,
    agent_session_id = excluded.agent_session_id
  returning id into v_item_id;

  if v_prior_ids is not null then
    update source_items
    set lifecycle_status = 'superseded'
    where id = any(v_prior_ids);
  end if;

  return jsonb_build_object(
    'item_id', v_item_id,
    'changed', v_changed,
    'superseded_item_ids', coalesce(to_jsonb(v_prior_ids), '[]'::jsonb)
  );
end;
$$;

revoke all on function upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid,
  text, timestamptz, timestamptz, uuid
) from public;
grant execute on function upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid,
  text, timestamptz, timestamptz, uuid
) to service_role;

-- claim_pending_summary_sessions
drop function if exists claim_pending_summary_sessions(uuid, int, int);
-- Claims up to p_limit sessions eligible for summarization: pending, or
-- leased with an expired lease (a worker crashed mid-run), or failed with
-- fewer than 3 attempts. Sessions whose lease expired after 3 attempts are
-- marked skipped first, so no session is retried more than 3 times.
-- Locks eligible rows with SKIP LOCKED so concurrent callers never
-- double-claim, then marks them leased with a fresh expiry.
create or replace function claim_pending_summary_sessions(
  p_workspace_id uuid,
  p_limit int,
  p_lease_seconds int
)
returns setof agent_sessions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  update agent_sessions
  set summary_status = 'skipped',
      summary_last_error = coalesce(summary_last_error, 'exceeded_max_summary_attempts')
  where workspace_id = p_workspace_id
    and summary_status = 'leased'
    and summary_lease_until < now()
    and summary_attempts >= 3;

  select array_agg(id) into v_ids
  from (
    select id
    from agent_sessions
    where workspace_id = p_workspace_id
      and (
        summary_status = 'pending'
        or (summary_status = 'leased' and summary_lease_until < now())
        or (summary_status = 'failed' and summary_attempts < 3)
      )
    order by started_at asc
    limit p_limit
    for update skip locked
  ) eligible;

  if v_ids is null then
    return;
  end if;

  return query
    update agent_sessions
    set summary_status = 'leased',
        summary_lease_until = now() + make_interval(secs => p_lease_seconds),
        summary_attempts = summary_attempts + 1
    where id = any(v_ids)
    returning *;
end;
$$;

revoke all on function claim_pending_summary_sessions(uuid, int, int) from public;
grant execute on function claim_pending_summary_sessions(uuid, int, int) to service_role;

-- replace_agent_session_messages
drop function if exists replace_captured_session_messages(uuid, text, text, uuid, uuid, text, text, timestamptz, timestamptz, text, jsonb, uuid);
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

-- append_session_events
drop function if exists append_session_events(uuid, uuid, text, jsonb);
-- Session status:
--   starting -> live -> ended
--   starting/live --no heartbeat for 60 s--> host_offline --same host heartbeat--> live
-- Idle is not stored. Writes for an ended session are rejected.
--
-- Appends a batch of events in order. Seq comes from the session's counter, so
-- it has no gaps. A duplicate source_id is skipped and does not use a seq.
-- open_approval_count goes up for a new permission_request and down for a new permission_resolved.
-- Each row is its own insert statement, so the statement trigger would signal once per row.
-- The function turns the trigger off for this transaction and sends one signal for the batch.
create or replace function append_session_events(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_machine_id text,
  p_events jsonb -- array of {source_id, kind, payload}
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session sessions%rowtype;
  v_event jsonb;
  v_seq bigint;
  v_inserted integer := 0;
  v_count integer;
  v_approvals integer := 0;
begin
  select * into v_session
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_session.status = 'ended' then
    raise exception 'session_ended';
  end if;
  if v_session.host_machine_id is distinct from p_host_machine_id then
    raise exception 'foreign_host';
  end if;

  v_seq := v_session.last_seq;
  perform set_config('draft.skip_event_signal', 'on', true);

  for v_event in select * from jsonb_array_elements(p_events) loop
    insert into session_events (session_id, workspace_id, seq, source_id, kind, payload)
    values (
      p_session_id, p_workspace_id, v_seq + 1,
      v_event->>'source_id', v_event->>'kind', coalesce(v_event->'payload', '{}'::jsonb)
    )
    on conflict (session_id, source_id) do nothing;

    get diagnostics v_count = row_count;
    if v_count > 0 then
      v_seq := v_seq + 1;
      v_inserted := v_inserted + 1;
      if v_event->>'kind' = 'permission_request' then
        v_approvals := v_approvals + 1;
      elsif v_event->>'kind' = 'permission_resolved' then
        v_approvals := v_approvals - 1;
      end if;
    end if;
  end loop;

  if v_inserted > 0 then
    update sessions
    set last_seq = v_seq,
        last_event_at = now(),
        last_seen = now(),
        status = 'live',
        open_approval_count = greatest(0, open_approval_count + v_approvals)
    where id = p_session_id;

    perform broadcast_signal('signals:session:' || p_session_id, 'events', jsonb_build_object('seq', v_seq));
    perform broadcast_signal('signals:workspace:' || p_workspace_id, 'sessions');
  end if;

  perform set_config('draft.skip_event_signal', 'off', true);

  return jsonb_build_object('last_seq', v_seq, 'inserted', v_inserted);
end;
$$;

revoke all on function append_session_events(uuid, uuid, text, jsonb) from public;
grant execute on function append_session_events(uuid, uuid, text, jsonb) to service_role;

-- heartbeat_session
drop function if exists heartbeat_session(uuid, uuid, text, text, text, text);
-- Records that the host is alive, and the modes the session is in. A host_offline session returns to live.
-- A session that is still starting stays starting. Writes for an ended session
-- or from another host are rejected.
create or replace function heartbeat_session(
  p_session_id uuid,
  p_workspace_id uuid,
  p_host_machine_id text,
  p_harness_version text default null,
  p_permission_mode text default null,
  p_approval_mode text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session sessions%rowtype;
  v_status text;
begin
  select * into v_session
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_session.status = 'ended' then
    raise exception 'session_ended';
  end if;
  if v_session.host_machine_id is distinct from p_host_machine_id then
    raise exception 'foreign_host';
  end if;

  v_status := case when v_session.status = 'host_offline' then 'live' else v_session.status end;

  update sessions
  set last_seen = now(),
      status = v_status,
      harness_version = coalesce(p_harness_version, harness_version),
      permission_mode = coalesce(p_permission_mode, permission_mode),
      approval_mode = coalesce(p_approval_mode, approval_mode)
  where id = p_session_id;

  return v_status;
end;
$$;

revoke all on function heartbeat_session(uuid, uuid, text, text, text, text) from public;
grant execute on function heartbeat_session(uuid, uuid, text, text, text, text) to service_role;

-- host_transition_session_input
drop function if exists host_transition_session_input(uuid, uuid, uuid, uuid, text, text[], text, text);
-- A session's host changes the state of an input. It checks the caller owns the session and the
-- request comes from the computer that runs it, so the route needs no session lookup of its own.
-- A host may mark a stop or a decision consumed, but never a message: the transcript does that.
create or replace function host_transition_session_input(
  p_input_id uuid,
  p_session_id uuid,
  p_workspace_id uuid,
  p_owner_user_id uuid,
  p_host_machine_id text,
  p_from text[],
  p_to text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_host text;
  v_kind text;
begin
  select owner_user_id, host_machine_id into v_owner, v_host
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_owner is distinct from p_owner_user_id then
    raise exception 'not_session_owner';
  end if;
  if v_host is distinct from p_host_machine_id then
    raise exception 'foreign_host';
  end if;

  if p_to = 'consumed' then
    select kind into v_kind from session_inputs where id = p_input_id and session_id = p_session_id;
    if v_kind is null or v_kind = 'message' then
      raise exception 'invalid_state';
    end if;
  end if;

  return transition_session_input(p_input_id, p_session_id, p_from, p_to, p_reason, null);
end;
$$;

revoke all on function host_transition_session_input(uuid, uuid, uuid, uuid, text, text[], text, text) from public;
grant execute on function host_transition_session_input(uuid, uuid, uuid, uuid, text, text[], text, text) to service_role;

-- commit_slack_source_batch
drop function if exists commit_slack_source_batch(uuid, uuid, text, uuid[], text, text, timestamptz, timestamptz, timestamptz, text, text, jsonb);
create or replace function commit_slack_source_batch(
  p_workspace_id uuid,
  p_source_connection_id uuid,
  p_channel_id text,
  p_message_ids uuid[],
  p_external_id text,
  p_external_version text,
  p_occurred_at timestamptz,
  p_source_time_start timestamptz,
  p_source_time_end timestamptz,
  p_content_markdown text,
  p_content_hash text,
  p_metadata_json jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_status text;
  v_locked_ids uuid[];
  v_upsert jsonb;
  v_item_id uuid;
  v_next_sequence bigint;
  v_now timestamptz := now();
begin
  select status into v_connection_status
  from source_connections
  where id = p_source_connection_id and workspace_id = p_workspace_id
  for update;

  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using errcode = 'P0001', message = 'connection_inactive';
  end if;

  with locked as (
    select id
    from slack_messages
    where id = any(p_message_ids)
      and workspace_id = p_workspace_id
      and source_connection_id = p_source_connection_id
      and channel_id = p_channel_id
      and source_item_id is null
    for update
  )
  select array_agg(id order by id) into v_locked_ids from locked;

  if coalesce(cardinality(v_locked_ids), 0) <> cardinality(p_message_ids) then
    return jsonb_build_object('status', 'stale_batch');
  end if;

  v_upsert := upsert_source_item(
    p_workspace_id, p_source_connection_id, 'message', p_external_id,
    p_external_version, p_occurred_at, p_content_markdown, p_content_hash,
    p_metadata_json || jsonb_build_object('time_basis', 'source_event'), null,
    'active', 'shared', null, 'source', p_source_time_start, p_source_time_end, null
  );
  v_item_id := (v_upsert->>'item_id')::uuid;

  update slack_messages set source_item_id = v_item_id where id = any(p_message_ids);

  v_next_sequence := next_workspace_event_sequence(p_workspace_id);

  insert into workspace_events (
    workspace_id, sequence_number, event_type, source_connection_id, summary, payload_json, occurred_at
  ) values (
    p_workspace_id, v_next_sequence, 'source_items_added', p_source_connection_id,
    format('Batched %s Slack message(s) from channel %s', cardinality(p_message_ids), p_channel_id),
    jsonb_build_object('channel_id', p_channel_id, 'message_count', cardinality(p_message_ids), 'source_item_id', v_item_id),
    v_now
  );

  return jsonb_build_object('status', 'committed', 'item_id', v_item_id);
end;
$$;

revoke all on function commit_slack_source_batch(uuid, uuid, text, uuid[], text, text, timestamptz, timestamptz, timestamptz, text, text, jsonb) from public;
grant execute on function commit_slack_source_batch(uuid, uuid, text, uuid[], text, text, timestamptz, timestamptz, timestamptz, text, text, jsonb) to service_role;

-- get_pending_slack_channel_ids
drop function if exists get_pending_slack_channel_ids(uuid, uuid, text, int);
create or replace function get_pending_slack_channel_ids(
  p_workspace_id uuid,
  p_source_connection_id uuid,
  p_after_channel_id text default null,
  p_limit int default 100
)
returns table (channel_id text)
language sql
security definer
set search_path = public
stable
as $$
  select distinct sm.channel_id
  from slack_messages sm
  where sm.workspace_id = p_workspace_id
    and sm.source_connection_id = p_source_connection_id
    and sm.source_item_id is null
    and (p_after_channel_id is null or sm.channel_id > p_after_channel_id)
  order by sm.channel_id
  limit greatest(1, least(p_limit, 500));
$$;

revoke all on function get_pending_slack_channel_ids(uuid, uuid, text, int) from public;
grant execute on function get_pending_slack_channel_ids(uuid, uuid, text, int) to service_role;

-- upsert_slack_message_if_connection_active
drop function if exists upsert_slack_message_if_connection_active(uuid, uuid, text, text, text, text, text, text, text, text, text, text, boolean, timestamptz, timestamptz, jsonb, jsonb, jsonb, jsonb, timestamptz);
-- Atomically verifies that Slack ingestion is still allowed and captures one
-- message. The connection row lock serializes this final write with
-- disconnect_source_connection; source_item_id is deliberately not an input,
-- so a repeated capture cannot clear a later materialization link.
create or replace function upsert_slack_message_if_connection_active(
  p_workspace_id uuid,
  p_source_connection_id uuid,
  p_channel_id text,
  p_channel_name_snapshot text,
  p_message_ts text,
  p_message_version text,
  p_thread_ts text,
  p_parent_user_id text,
  p_slack_user_id text,
  p_user_name_snapshot text,
  p_text text,
  p_subtype text,
  p_is_deleted boolean,
  p_edited_at timestamptz,
  p_deleted_at timestamptz,
  p_blocks_json jsonb,
  p_files_json jsonb,
  p_reactions_json jsonb,
  p_provider_metadata_json jsonb,
  p_captured_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_status text;
  v_message_id uuid;
begin
  select status into v_connection_status
  from source_connections
  where id = p_source_connection_id
    and workspace_id = p_workspace_id
    and provider = 'slack'
  for update;

  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using
      errcode = 'P0001',
      message = 'connection_inactive';
  end if;

  insert into slack_messages (
    workspace_id, source_connection_id, channel_id, channel_name_snapshot,
    message_ts, message_version, thread_ts, parent_user_id, slack_user_id,
    user_name_snapshot, text, subtype, is_deleted, edited_at, deleted_at,
    blocks_json, files_json, reactions_json, provider_metadata_json, captured_at
  ) values (
    p_workspace_id, p_source_connection_id, p_channel_id,
    p_channel_name_snapshot, p_message_ts, p_message_version, p_thread_ts,
    p_parent_user_id, p_slack_user_id, p_user_name_snapshot, p_text, p_subtype,
    p_is_deleted, p_edited_at, p_deleted_at, coalesce(p_blocks_json, '[]'::jsonb),
    coalesce(p_files_json, '[]'::jsonb), coalesce(p_reactions_json, '[]'::jsonb),
    coalesce(p_provider_metadata_json, '{}'::jsonb), p_captured_at
  )
  on conflict (source_connection_id, channel_id, message_ts, message_version)
  do update set
    channel_name_snapshot = excluded.channel_name_snapshot,
    thread_ts = excluded.thread_ts,
    parent_user_id = excluded.parent_user_id,
    slack_user_id = excluded.slack_user_id,
    user_name_snapshot = excluded.user_name_snapshot,
    text = excluded.text,
    subtype = excluded.subtype,
    is_deleted = excluded.is_deleted,
    edited_at = excluded.edited_at,
    deleted_at = excluded.deleted_at,
    blocks_json = excluded.blocks_json,
    files_json = excluded.files_json,
    reactions_json = excluded.reactions_json,
    provider_metadata_json = excluded.provider_metadata_json,
    captured_at = excluded.captured_at
  returning id into v_message_id;

  return jsonb_build_object('message_id', v_message_id);
end;
$$;

revoke all on function upsert_slack_message_if_connection_active(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text,
  boolean, timestamptz, timestamptz, jsonb, jsonb, jsonb, jsonb, timestamptz
) from public;
grant execute on function upsert_slack_message_if_connection_active(
  uuid, uuid, text, text, text, text, text, text, text, text, text, text,
  boolean, timestamptz, timestamptz, jsonb, jsonb, jsonb, jsonb, timestamptz
) to service_role;

-- disconnect_source_connection
drop function if exists disconnect_connection(uuid, text, uuid, text);
-- Revokes one live provider connection owned by the caller and disables all
-- of its scheduled work in the same transaction. Reports which case
-- occurred ('disconnected' / 'not_found' / 'not_owner') so the route can
-- return the right status without a separate ownership pre-check query --
-- this RPC is the single source of truth for the ownership rule.
--
-- p_account_kind is an optional filter needed only by Granola, which can
-- have both a caller-owned personal row and a separate null-owner workspace
-- row live at once for the same (workspace, provider) -- every other
-- provider has at most one live row and every existing caller omits this
-- argument, keeping the prior "most recently updated" behavior unchanged.
create or replace function disconnect_source_connection(
  p_workspace_id uuid,
  p_provider text,
  p_connected_by_user_id uuid,
  p_account_kind text default null
)
returns table(connection_id uuid, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_id uuid;
  v_owner uuid;
begin
  select sc.id, sc.connected_by_user_id into v_connection_id, v_owner
  from source_connections sc
  where sc.workspace_id = p_workspace_id
    and sc.provider = p_provider
    and sc.status <> 'revoked'
    and (
      p_account_kind is null
      or (p_account_kind = 'personal' and sc.connected_by_user_id = p_connected_by_user_id)
      or (p_account_kind = 'workspace' and sc.connected_by_user_id is null)
    )
  order by sc.updated_at desc, sc.id desc
  limit 1
  for update;

  if not found then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;

  -- A null owner (older rows, or a provider that was never personally
  -- attributed) is unowned, not "owned by no one" -- anyone with workspace
  -- access may still disconnect it.
  if v_owner is not null and v_owner <> p_connected_by_user_id then
    return query select v_connection_id, 'not_owner'::text;
    return;
  end if;

  update source_connections
  set status = 'revoked'
  where id = v_connection_id
    and workspace_id = p_workspace_id;

  update scheduled_tasks
  set enabled = false
  where source_connection_id = v_connection_id
    and workspace_id = p_workspace_id
    and enabled;

  return query select v_connection_id, 'disconnected'::text;
end;
$$;

revoke all on function disconnect_source_connection(uuid, text, uuid, text) from public;
grant execute on function disconnect_source_connection(uuid, text, uuid, text) to service_role;

-- commit_linear_connection_swap
-- Commits the local half of a Linear webhook replacement. The caller creates
-- the upstream webhook first and compensates by deleting it if this function
-- raises linear_connection_conflict. The workspace lock covers first connect
-- (where no provider row exists yet); reconnects additionally compare the
-- source_connections.updated_at value observed before the network call.
create or replace function commit_linear_connection_swap(
  p_workspace_id uuid,
  p_expected_updated_at timestamptz,
  p_connection_key text,
  p_encrypted_payload bytea,
  p_encryption_key_version text,
  p_linear_webhook_id text,
  p_connected_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection source_connections%rowtype;
  v_credential_id uuid;
  v_prior_webhook_id text;
  v_pending_webhook_ids jsonb := '[]'::jsonb;
begin
  -- A provider row cannot be locked before the first connection exists, so
  -- serialize creation by locking its workspace. This also makes the lookup
  -- and expected-version comparison one atomic decision.
  perform 1
  from workspaces
  where id = p_workspace_id
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'linear_connection_conflict';
  end if;

  select * into v_connection
  from source_connections
  where workspace_id = p_workspace_id
    and provider = 'linear'
  order by created_at asc, id asc
  limit 1
  for update;

  if found then
    if p_expected_updated_at is null
       or v_connection.updated_at is distinct from p_expected_updated_at then
      raise exception using
        errcode = 'P0001',
        message = 'linear_connection_conflict';
    end if;

    v_prior_webhook_id := v_connection.config_json ->> 'linear_webhook_id';
    select coalesce(jsonb_agg(webhook_id order by first_position), '[]'::jsonb)
    into v_pending_webhook_ids
    from (
      select webhook_id, min(item_order) as first_position
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(v_connection.config_json -> 'linear_cleanup_pending_webhook_ids') = 'array'
            then v_connection.config_json -> 'linear_cleanup_pending_webhook_ids'
          else '[]'::jsonb
        end || jsonb_build_array(v_prior_webhook_id)
      ) with ordinality as pending(webhook_id, item_order)
      where webhook_id is not null
        and webhook_id <> ''
        and webhook_id <> p_linear_webhook_id
      group by webhook_id
    ) deduplicated;
    v_credential_id := v_connection.credential_id;

    if v_credential_id is null then
      insert into credentials (
        workspace_id, provider, encrypted_payload, encryption_key_version, status
      ) values (
        p_workspace_id, 'linear', p_encrypted_payload,
        p_encryption_key_version, 'active'
      )
      returning id into v_credential_id;
    else
      update credentials
      set provider = 'linear',
          encrypted_payload = p_encrypted_payload,
          encryption_key_version = p_encryption_key_version,
          status = 'active'
      where id = v_credential_id
        and workspace_id = p_workspace_id;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'linear_connection_conflict';
      end if;
    end if;

    update source_connections
    set connection_key = p_connection_key,
        credential_id = v_credential_id,
        config_json = (coalesce(config_json, '{}'::jsonb) - 'linear_cleanup_pending_webhook_ids')
          || jsonb_build_object('linear_webhook_id', p_linear_webhook_id)
          || case
            when jsonb_array_length(v_pending_webhook_ids) > 0 then
              jsonb_build_object('linear_cleanup_pending_webhook_ids', v_pending_webhook_ids)
            else '{}'::jsonb
          end,
        status = 'active',
        connected_by_user_id = coalesce(p_connected_by_user_id, connected_by_user_id),
        last_error_at = null
    where id = v_connection.id
      and workspace_id = p_workspace_id
    returning * into v_connection;
  else
    if p_expected_updated_at is not null then
      raise exception using
        errcode = 'P0001',
        message = 'linear_connection_conflict';
    end if;

    insert into credentials (
      workspace_id, provider, encrypted_payload, encryption_key_version, status
    ) values (
      p_workspace_id, 'linear', p_encrypted_payload,
      p_encryption_key_version, 'active'
    )
    returning id into v_credential_id;

    insert into source_connections (
      workspace_id, provider, connection_key, status, credential_id,
      config_json, connected_by_user_id, last_error_at
    ) values (
      p_workspace_id, 'linear', p_connection_key, 'active', v_credential_id,
      jsonb_build_object('linear_webhook_id', p_linear_webhook_id),
      p_connected_by_user_id, null
    )
    returning * into v_connection;
  end if;

  return jsonb_build_object(
    'connection_id', v_connection.id,
    'credential_id', v_credential_id,
    'prior_webhook_id', v_prior_webhook_id,
    'updated_at', v_connection.updated_at
  );
end;
$$;

revoke all on function commit_linear_connection_swap(
  uuid, timestamptz, text, bytea, text, text, uuid
) from public;
grant execute on function commit_linear_connection_swap(
  uuid, timestamptz, text, bytea, text, text, uuid
) to service_role;

-- mark_fireflies_webhook_success
-- Advances webhook readiness only for the credential generation that
-- authenticated the delivery.
create or replace function mark_fireflies_webhook_success(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_credential_id uuid,
  p_succeeded_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update source_connections
  set last_success_at = p_succeeded_at
  where id = p_connection_id
    and workspace_id = p_workspace_id
    and provider = 'fireflies'
    and credential_id = p_credential_id
    and status in ('active', 'degraded');

  return found;
end;
$$;

revoke all on function mark_fireflies_webhook_success(
  uuid, uuid, uuid, timestamptz
) from public;
grant execute on function mark_fireflies_webhook_success(
  uuid, uuid, uuid, timestamptz
) to service_role;

-- mark_granola_webhook_success
-- Advances webhook readiness only for the credential generation that
-- authenticated the delivery, same generation-pinning as
-- mark_fireflies_webhook_success.
create or replace function mark_granola_webhook_success(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_credential_id uuid,
  p_succeeded_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update source_connections
  set last_success_at = p_succeeded_at
  where id = p_connection_id
    and workspace_id = p_workspace_id
    and provider = 'granola'
    and credential_id = p_credential_id
    and status in ('active', 'degraded');

  return found;
end;
$$;

revoke all on function mark_granola_webhook_success(
  uuid, uuid, uuid, timestamptz
) from public;
grant execute on function mark_granola_webhook_success(
  uuid, uuid, uuid, timestamptz
) to service_role;

-- rotate_fireflies_connection_credential
-- Rotates a Fireflies credential generation and resets webhook readiness in
-- one transaction. A new credential id is the immutable generation token.
create or replace function rotate_fireflies_connection_credential(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_encrypted_payload bytea,
  p_encryption_key_version text,
  p_connected_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection source_connections%rowtype;
  v_prior_credential_id uuid;
  v_new_credential_id uuid;
begin
  select * into v_connection
  from source_connections
  where id = p_connection_id
    and workspace_id = p_workspace_id
    and provider = 'fireflies'
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'fireflies_connection_conflict';
  end if;

  v_prior_credential_id := v_connection.credential_id;

  insert into credentials (
    workspace_id, provider, encrypted_payload, encryption_key_version, status
  ) values (
    p_workspace_id, 'fireflies', p_encrypted_payload,
    p_encryption_key_version, 'active'
  )
  returning id into v_new_credential_id;

  update source_connections
  set credential_id = v_new_credential_id,
      status = 'active',
      connected_by_user_id = coalesce(p_connected_by_user_id, connected_by_user_id),
      last_success_at = null,
      last_error_at = null
  where id = v_connection.id
    and workspace_id = p_workspace_id;

  if v_prior_credential_id is not null then
    update credentials
    set status = 'revoked'
    where id = v_prior_credential_id
      and workspace_id = p_workspace_id;
  end if;

  return jsonb_build_object(
    'connection_id', v_connection.id,
    'connection_key', v_connection.connection_key,
    'credential_id', v_new_credential_id
  );
end;
$$;

revoke all on function rotate_fireflies_connection_credential(
  uuid, uuid, bytea, text, uuid
) from public;
grant execute on function rotate_fireflies_connection_credential(
  uuid, uuid, bytea, text, uuid
) to service_role;

-- rotate_granola_connection_credential
-- Rotates a Granola credential generation. Simpler than the Fireflies
-- equivalent: Granola's webhook endpoint is a separate object keyed by its
-- own id (stored inside the credential payload), not tied to the API key
-- value, so rotating the key never needs to touch or recreate the webhook.
create or replace function rotate_granola_connection_credential(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_encrypted_payload bytea,
  p_encryption_key_version text,
  p_connected_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection source_connections%rowtype;
  v_prior_credential_id uuid;
  v_new_credential_id uuid;
begin
  select * into v_connection
  from source_connections
  where id = p_connection_id
    and workspace_id = p_workspace_id
    and provider = 'granola'
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'granola_connection_conflict';
  end if;

  v_prior_credential_id := v_connection.credential_id;

  insert into credentials (
    workspace_id, provider, encrypted_payload, encryption_key_version, status
  ) values (
    p_workspace_id, 'granola', p_encrypted_payload,
    p_encryption_key_version, 'active'
  )
  returning id into v_new_credential_id;

  update source_connections
  set credential_id = v_new_credential_id,
      status = 'active',
      connected_by_user_id = coalesce(p_connected_by_user_id, connected_by_user_id),
      last_success_at = null,
      last_error_at = null
  where id = v_connection.id
    and workspace_id = p_workspace_id;

  if v_prior_credential_id is not null then
    update credentials
    set status = 'revoked'
    where id = v_prior_credential_id
      and workspace_id = p_workspace_id;
  end if;

  return jsonb_build_object(
    'connection_id', v_connection.id,
    'connection_key', v_connection.connection_key,
    'credential_id', v_new_credential_id
  );
end;
$$;

revoke all on function rotate_granola_connection_credential(
  uuid, uuid, bytea, text, uuid
) from public;
grant execute on function rotate_granola_connection_credential(
  uuid, uuid, bytea, text, uuid
) to service_role;

-- 8. The environment key of a cloud runtime or a routine config (reverse of the toolset move).
-- Triggers stay off for the update, so updated_at keeps its value.
alter table agent_runs disable trigger agent_runs_set_updated_at;
update agent_runs
set runtime = (runtime - 'toolset') || jsonb_build_object('environment', runtime->'toolset')
where runtime ? 'toolset';
alter table agent_runs enable trigger agent_runs_set_updated_at;

alter table scheduled_tasks disable trigger scheduled_tasks_set_updated_at;
update scheduled_tasks
set config_json = (config_json - 'toolset') || jsonb_build_object('environment', config_json->'toolset')
where config_json ? 'toolset';
alter table scheduled_tasks enable trigger scheduled_tasks_set_updated_at;

commit;
