
create index session_events_scope_seq_idx on session_events (session_id, (nullif(payload->>'agent_id', '')), seq);
create index session_events_tool_idx on session_events (session_id, (payload->>'tool_use_id'), seq) where kind in ('tool_use', 'tool_result');
create index session_events_permission_idx on session_events (session_id, (payload->>'requestId'), seq) where kind in ('permission_request', 'permission_resolved');
create index session_events_kind_seq_idx on session_events (session_id, kind, seq);

-- A scoped transcript page and, on request, current state from one MVCC snapshot.
create or replace function read_session_view(
  p_workspace_id uuid, p_session_id uuid, p_agent_id text default null,
  p_before bigint default null, p_after bigint default null, p_around bigint default null,
  p_through bigint default null, p_limit integer default 200, p_state boolean default true
) returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  s sessions%rowtype;
  h bigint;
  a text := nullif(p_agent_id, '');
  n integer := least(200, greatest(1, p_limit));
  lo bigint;
  hi bigint;
  rows jsonb;
  support jsonb;
  older boolean;
  newer boolean;
  result jsonb;
  agents jsonb;
  approvals jsonb;
begin
  if num_nonnulls(p_before, p_after, p_around) > 1 then raise exception 'invalid_cursor'; end if;
  select * into s from sessions where id = p_session_id and workspace_id = p_workspace_id and deleted_at is null;
  if not found then raise exception 'session_not_found'; end if;
  h := least(s.last_seq, coalesce(p_through, s.last_seq));
  if p_around is not null then
    select nullif(payload->>'agent_id', '') into a from session_events
      where session_id = p_session_id and seq = p_around and seq <= h;
    if not found then raise exception 'event_not_found'; end if;
  end if;

  with selected as (
    (select e.* from session_events e
      where session_id = p_session_id and nullif(payload->>'agent_id', '') is not distinct from a
        and seq <= h and (p_before is null or seq < p_before)
        and (p_after is null or seq > p_after) and (p_around is null or seq <= p_around)
      order by case when p_after is not null then seq end asc, seq desc
      limit case when p_around is null then n else greatest(1, n / 2) end)
    union all
    (select e.* from session_events e
      where p_around is not null and session_id = p_session_id
        and nullif(payload->>'agent_id', '') is not distinct from a and seq > p_around and seq <= h
      order by seq limit n - greatest(1, n / 2))
  ) select coalesce(jsonb_agg(to_jsonb(selected) - 'workspace_id' - 'session_id' order by seq), '[]'), min(seq), max(seq)
    into rows, lo, hi from selected;

  select exists(select 1 from session_events where session_id = p_session_id
      and nullif(payload->>'agent_id', '') is not distinct from a and seq < coalesce(lo, p_before, p_after, h + 1)),
    exists(select 1 from session_events where session_id = p_session_id
      and nullif(payload->>'agent_id', '') is not distinct from a and seq > coalesce(hi, p_after, h) and seq <= h)
    into older, newer;

  with primary_events as (select * from jsonb_to_recordset(rows) as r(seq bigint, kind text, payload jsonb)),
  related as (
    select distinct e.* from primary_events r join session_events e
      on e.session_id = p_session_id and e.seq <= h
      and nullif(e.payload->>'agent_id', '') is not distinct from a
      and ((r.kind in ('tool_use', 'tool_result') and e.kind in ('tool_use', 'tool_result')
        and e.payload->>'tool_use_id' = r.payload->>'tool_use_id')
        or (r.kind in ('permission_request', 'permission_resolved') and e.kind in ('permission_request', 'permission_resolved')
        and e.payload->>'requestId' = r.payload->>'requestId'))
      where not exists(select 1 from primary_events p where p.seq = e.seq)
  ) select coalesce(jsonb_agg(to_jsonb(related) - 'workspace_id' - 'session_id' order by seq), '[]') into support from related;

  result := jsonb_build_object('page', jsonb_build_object('agentId', a, 'events', rows, 'dependencies', support,
    'before', lo, 'after', hi, 'hasOlder', older, 'hasNewer', newer,
    'through', h, 'readThrough', case when newer then coalesce(hi, p_after, 0) else h end));
  if not p_state then return result; end if;

  select coalesce(jsonb_agg(to_jsonb(e) - 'workspace_id' - 'session_id' order by seq), '[]') into approvals
    from session_events e where e.session_id = p_session_id and e.seq <= h and e.kind = 'permission_request'
      and not exists(select 1 from session_events r where r.session_id = p_session_id and r.seq <= h
        and r.kind = 'permission_resolved' and r.payload->>'requestId' = e.payload->>'requestId');

  with stats as (
    select payload->>'agent_id' as id, min(seq) as first_seq, max(seq) as last_seq,
      count(*) filter(where kind = 'tool_use') as steps
    from session_events where session_id = p_session_id and seq <= h and nullif(payload->>'agent_id', '') is not null
    group by payload->>'agent_id'
  ), spawns as (
    select e.seq, e.payload->'input' as input, r.payload as result,
      substring(r.payload->>'content' from 'agent_?[iI]d:\s*([A-Za-z0-9_-]+)') as id
    from session_events e left join lateral (
      select payload from session_events where session_id = p_session_id and seq <= h and kind = 'tool_result'
        and payload->>'tool_use_id' = e.payload->>'tool_use_id' order by seq desc limit 1
    ) r on true
    where e.session_id = p_session_id and e.seq <= h and e.kind = 'tool_use'
      and nullif(e.payload->>'agent_id', '') is null and e.payload->>'name' in ('Agent', 'Task')
  ), catalog as (
    select coalesce(spawns.id, stats.id) as id, spawns.seq as host_seq, stats.first_seq, stats.last_seq,
      coalesce(stats.steps, 0) as steps, spawns.input, spawns.result
    from spawns full join stats on spawns.id = stats.id
  ) select coalesce(jsonb_agg(jsonb_build_object(
      'key', case when id is not null then 'agent:' || id else 'spawn:' || host_seq end,
      'agentId', id, 'hostSeq', host_seq, 'firstSeq', coalesce(first_seq, host_seq), 'lastSeq', coalesce(last_seq, host_seq),
      'name', input->>'name', 'description', input->>'description', 'model', input->>'model', 'steps', steps,
      'isError', coalesce((result->>'is_error')::boolean, false),
      'state', case when s.status = 'ended' or result->>'is_error' = 'true' then 'idle'
        when nullif(input->>'name', '') is null and result is not null then 'idle'
        when coalesce((select max(seq) from session_events where session_id = p_session_id and seq <= h
          and kind = 'session_note' and nullif(payload->>'agent_id', '') is null
          and payload->'agent_message'->>'from' = catalog.input->>'name' and payload->'agent_message'->>'type' = 'idle'), 0)
        > coalesce((select max(seq) from session_events where session_id = p_session_id and seq <= h
          and kind = 'session_note' and payload->>'agent_id' = catalog.id
          and payload->'agent_message'->>'from' is distinct from catalog.input->>'name'), 0) then 'idle'
        else 'working' end
    ) order by coalesce(host_seq, first_seq)), '[]') into agents from catalog;
  return result || jsonb_build_object('snapshot', jsonb_build_object('session', to_jsonb(s), 'approvals', approvals, 'agents', agents));
end;
$$;
revoke all on function read_session_view(uuid, uuid, text, bigint, bigint, bigint, bigint, integer, boolean) from public;
grant execute on function read_session_view(uuid, uuid, text, bigint, bigint, bigint, bigint, integer, boolean) to service_role;
