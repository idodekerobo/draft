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
