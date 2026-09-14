drop function if exists upsert_source_item(
  uuid, uuid, text, text, text, timestamptz, text, text, jsonb, jsonb, text, text, uuid
);

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
  select status into v_connection_status
  from source_connections
  where id = p_source_connection_id and workspace_id = p_workspace_id
  for update;

  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using errcode = 'P0001', message = 'connection_inactive';
  end if;

  select content_hash into v_existing_hash
  from source_items
  where source_connection_id = p_source_connection_id
    and external_id = p_external_id
    and external_version = p_external_version
  for update;

  v_changed := v_existing_hash is distinct from p_content_hash;

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
    supersedes_source_item_id = coalesce(source_items.supersedes_source_item_id, excluded.supersedes_source_item_id),
    visibility = excluded.visibility,
    owner_user_id = excluded.owner_user_id,
    agent_session_id = excluded.agent_session_id
  returning id into v_item_id;

  if v_prior_ids is not null then
    update source_items set lifecycle_status = 'superseded' where id = any(v_prior_ids);
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

drop function if exists replace_agent_session_messages(
  uuid, text, text, uuid, uuid, text, text, timestamptz, timestamptz, text, jsonb
);

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
  p_messages jsonb,
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
  perform 1 from agent_sessions
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
    contributor_id = case when agent_sessions.user_id is not null then null else excluded.contributor_id end,
    project = excluded.project,
    cwd = excluded.cwd,
    ended_at = excluded.ended_at,
    status = excluded.status,
    session_project_id = coalesce(excluded.session_project_id, agent_sessions.session_project_id),
    transcript_revision = agent_sessions.transcript_revision + 1
  returning id, transcript_revision into v_session_id, v_transcript_revision;

  delete from agent_messages where session_id = v_session_id;

  insert into agent_messages (session_id, workspace_id, seq, role, content)
  select v_session_id, p_workspace_id, ordinality - 1, msg->>'role', msg->>'content'
  from jsonb_array_elements(p_messages) with ordinality as t(msg, ordinality);

  return jsonb_build_object('session_id', v_session_id, 'transcript_revision', v_transcript_revision);
end;
$$;

revoke all on function replace_agent_session_messages(
  uuid, text, text, uuid, uuid, text, text, timestamptz, timestamptz, text, jsonb, uuid
) from public;
grant execute on function replace_agent_session_messages(
  uuid, text, text, uuid, uuid, text, text, timestamptz, timestamptz, text, jsonb, uuid
) to service_role;

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

create or replace function search_sources(
  p_workspace_id uuid,
  p_caller_user_id uuid,
  p_query text,
  p_provider text default null,
  p_types text[] default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_after_rank real default null,
  p_after_occurred_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 11
)
returns table (
  source_item_id uuid, source_version text, title text, provider text, item_type text,
  representation_kind text, occurred_at timestamptz, source_time_start timestamptz,
  source_time_end timestamptz, metadata_json jsonb, content_markdown text,
  sanitized_raw_json jsonb, agent_session_id uuid, excerpt text, rank real
)
language sql security definer set search_path = public stable
as $$
  with ranked as (
    select si.id, si.external_version,
      coalesce(si.metadata_json->>'title', si.metadata_json->>'project') title,
      sc.provider, si.item_type, si.representation_kind, si.occurred_at,
      si.source_time_start, si.source_time_end, si.metadata_json,
      si.content_markdown, si.sanitized_raw_json, si.agent_session_id,
      ts_headline('english', coalesce(si.content_markdown, ''), websearch_to_tsquery('english', p_query),
        'MaxFragments=2, MaxWords=35, MinWords=15, StartSel=**, StopSel=**') excerpt,
      ts_rank_cd(to_tsvector('english', coalesce(si.content_markdown, '')),
        websearch_to_tsquery('english', p_query))::real rank
    from source_items si
    join source_connections sc on sc.id = si.source_connection_id and sc.workspace_id = si.workspace_id
    where si.workspace_id = p_workspace_id
      and si.lifecycle_status = 'active'
      and (si.visibility = 'shared' or si.owner_user_id = p_caller_user_id)
      and (p_provider is null or sc.provider = p_provider)
      and (p_types is null or si.item_type = any(p_types))
      and (p_since is null or coalesce(si.source_time_end, si.source_time_start, si.occurred_at) >= p_since)
      and (p_until is null or coalesce(si.source_time_start, si.source_time_end, si.occurred_at) < p_until)
      and to_tsvector('english', coalesce(si.content_markdown, '')) @@ websearch_to_tsquery('english', p_query)
  )
  select r.id, r.external_version, r.title, r.provider, r.item_type,
    r.representation_kind, r.occurred_at, r.source_time_start, r.source_time_end,
    r.metadata_json, r.content_markdown, r.sanitized_raw_json, r.agent_session_id, r.excerpt, r.rank
  from ranked r
  where p_after_rank is null or r.rank < p_after_rank
    or (r.rank = p_after_rank and r.occurred_at < p_after_occurred_at)
    or (r.rank = p_after_rank and r.occurred_at = p_after_occurred_at and r.id > p_after_id)
  order by r.rank desc, r.occurred_at desc, r.id asc
  limit greatest(1, least(p_limit, 101));
$$;

revoke all on function search_sources(uuid, uuid, text, text, text[], timestamptz, timestamptz, real, timestamptz, uuid, int) from public;
grant execute on function search_sources(uuid, uuid, text, text, text[], timestamptz, timestamptz, real, timestamptz, uuid, int) to service_role;

create or replace function get_pending_slack_channel_ids(
  p_workspace_id uuid, p_source_connection_id uuid,
  p_after_channel_id text default null, p_limit int default 100
)
returns table (channel_id text)
language sql security definer set search_path = public stable
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

create or replace function commit_slack_source_batch(
  p_workspace_id uuid, p_source_connection_id uuid, p_channel_id text,
  p_message_ids uuid[], p_external_id text, p_external_version text,
  p_occurred_at timestamptz, p_source_time_start timestamptz,
  p_source_time_end timestamptz, p_content_markdown text,
  p_content_hash text, p_metadata_json jsonb
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_connection_status text;
  v_locked_ids uuid[];
  v_upsert jsonb;
  v_item_id uuid;
  v_next_sequence bigint;
  v_now timestamptz := now();
begin
  select status into v_connection_status from source_connections
  where id = p_source_connection_id and workspace_id = p_workspace_id for update;
  if not found or v_connection_status not in ('active', 'degraded') then
    raise exception using errcode = 'P0001', message = 'connection_inactive';
  end if;
  with locked as (
    select id from slack_messages
    where id = any(p_message_ids) and workspace_id = p_workspace_id
      and source_connection_id = p_source_connection_id and channel_id = p_channel_id
      and source_item_id is null for update
  ) select array_agg(id order by id) into v_locked_ids from locked;
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

  -- Locking the workspace row before allocating sequence_number serializes
  -- it against every other workspace_events writer (commit_synthesis_run
  -- included), so two concurrent batch commits in the same workspace can
  -- never collide on the same sequence number.
  perform 1 from workspaces where id = p_workspace_id for update;
  select coalesce(max(sequence_number), 0) + 1 into v_next_sequence
  from workspace_events where workspace_id = p_workspace_id;

  insert into workspace_events (
    workspace_id, sequence_number, event_type, source_connection_id, summary, payload_json, occurred_at
  )
  values (p_workspace_id, v_next_sequence, 'source_items_added', p_source_connection_id,
    format('Batched %s Slack message(s) from channel %s', cardinality(p_message_ids), p_channel_id),
    jsonb_build_object('channel_id', p_channel_id, 'message_count', cardinality(p_message_ids), 'source_item_id', v_item_id),
    v_now);
  return jsonb_build_object('status', 'committed', 'item_id', v_item_id);
end;
$$;
revoke all on function commit_slack_source_batch(uuid, uuid, text, uuid[], text, text, timestamptz, timestamptz, timestamptz, text, text, jsonb) from public;
grant execute on function commit_slack_source_batch(uuid, uuid, text, uuid[], text, text, timestamptz, timestamptz, timestamptz, text, text, jsonb) to service_role;
