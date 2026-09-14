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

  -- Locking the workspace row before allocating sequence_number serializes
  -- it against every other workspace_events writer (commit_synthesis_run
  -- included), so two concurrent batch commits in the same workspace can
  -- never collide on the same sequence number.
  perform 1 from workspaces where id = p_workspace_id for update;
  select coalesce(max(sequence_number), 0) + 1 into v_next_sequence
  from workspace_events where workspace_id = p_workspace_id;

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
