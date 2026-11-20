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
  response jsonb;
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

  response := jsonb_build_object('page', jsonb_build_object('agentId', a, 'events', rows, 'dependencies', support,
    'before', lo, 'after', hi, 'hasOlder', older, 'hasNewer', newer,
    'through', h, 'readThrough', case when newer then coalesce(hi, p_after, 0) else h end));
  if not p_state then return response; end if;

  select coalesce(jsonb_agg(to_jsonb(e) - 'workspace_id' - 'session_id' order by seq), '[]') into approvals
    from session_events e where e.session_id = p_session_id and e.seq <= h and e.kind = 'permission_request'
      and not exists(select 1 from session_events r where r.session_id = p_session_id and r.seq <= h
        and r.kind = 'permission_resolved' and r.payload->>'requestId' = e.payload->>'requestId');

  with stats as (
    select payload->>'agent_id' as id, min(seq) as first_seq, max(seq) as last_seq,
      count(*) filter(where kind = 'tool_use') as steps
    from session_events where session_id = p_session_id and seq <= h and nullif(payload->>'agent_id', '') is not null
    group by payload->>'agent_id'
  ), spawns_all as (
    select e.seq, e.payload->'input' as input, r.payload as result,
      coalesce(r.payload->'agent_result'->>'id', e.payload->'input'->>'resume',
        substring(r.payload->>'content' from 'agent_?[iI]d:\s*([A-Za-z0-9_-]+)')) as id
    from session_events e left join lateral (
      select payload from session_events where session_id = p_session_id and seq <= h and kind = 'tool_result'
        and payload->>'tool_use_id' = e.payload->>'tool_use_id' order by seq desc limit 1
    ) r on true
    where e.session_id = p_session_id and e.seq <= h and e.kind = 'tool_use'
      and nullif(e.payload->>'agent_id', '') is null and e.payload->>'name' in ('Agent', 'Task')
  ), spawns as (
    select distinct on (coalesce(id, 'spawn:' || seq))
      first_value(seq) over (partition by coalesce(id, 'spawn:' || seq) order by seq) as seq,
      first_value(input) over (partition by coalesce(id, 'spawn:' || seq) order by seq) as input,
      spawns_all.seq as latest_spawn_seq, result, id
    from spawns_all order by coalesce(id, 'spawn:' || seq), spawns_all.seq desc
  ), catalog as (
    select coalesce(spawns.id, stats.id) as id, spawns.seq as host_seq, stats.first_seq, stats.last_seq,
      coalesce(stats.steps, 0) as steps, spawns.input, spawns.result, spawns.latest_spawn_seq
    from spawns full join stats on spawns.id = stats.id
  ) select coalesce(jsonb_agg(jsonb_build_object(
      'key', case when id is not null then 'agent:' || id else 'spawn:' || host_seq end,
      'agentId', id, 'hostSeq', host_seq, 'firstSeq', coalesce(first_seq, host_seq), 'lastSeq', coalesce(last_seq, host_seq),
      'name', input->>'name', 'description', coalesce(input->>'description', input->>'subagent_type'),
      'model', coalesce(result->'agent_result'->>'model', input->>'model'), 'steps', steps,
      'async', coalesce((result->'agent_result'->>'async')::boolean, false),
      'isError', coalesce((lifecycle.payload->'agent_lifecycle'->>'isError')::boolean, (result->>'is_error')::boolean, false),
      'state', case when s.status = 'ended' or result->>'is_error' = 'true' then 'idle'
        when lifecycle.payload is not null then lifecycle.payload->'agent_lifecycle'->>'state'
        when nullif(input->>'name', '') is null and result is not null
          and coalesce((result->'agent_result'->>'async')::boolean, false) = false then 'idle'
        when coalesce((select max(seq) from session_events where session_id = p_session_id and seq <= h
          and kind = 'session_note' and nullif(payload->>'agent_id', '') is null
          and payload->'agent_message'->>'from' = catalog.input->>'name' and payload->'agent_message'->>'type' = 'idle'), 0)
        > greatest(coalesce(catalog.latest_spawn_seq, 0), coalesce((select max(seq) from session_events where session_id = p_session_id and seq <= h
          and kind = 'session_note' and payload->>'agent_id' = catalog.id
          and payload->'agent_message'->>'from' is distinct from catalog.input->>'name'), 0)) then 'idle'
        else 'working' end
    ) order by coalesce(host_seq, first_seq)), '[]') into agents from catalog
    left join lateral (
      select case when e.payload->'agent_lifecycle' is not null then e.payload
        when e.payload->'agent_message'->>'type' = 'idle' and nullif(e.payload->>'agent_id', '') is null
          then jsonb_build_object('agent_lifecycle', jsonb_build_object('state', 'idle', 'isError', false))
        else jsonb_build_object('agent_lifecycle', jsonb_build_object('state', 'working', 'isError', false)) end as payload
      from session_events e
      where e.session_id = p_session_id and e.seq <= h
        and (e.payload->'agent_lifecycle'->>'id' = catalog.id
          or (e.payload->>'agent_id' = catalog.id and e.kind in ('tool_use', 'tool_result', 'assistant_text', 'thinking'))
          or (nullif(e.payload->>'agent_id', '') is null and e.payload->'agent_message'->>'from' = catalog.input->>'name'
            and e.payload->'agent_message'->>'type' = 'idle')
          or (e.payload->>'agent_id' = catalog.id and e.payload->'agent_message'->>'from' is distinct from catalog.input->>'name'
            and e.payload->'agent_message' is not null))
        and (coalesce(e.payload->>'timestamp', e.created_at::text)::timestamptz, e.seq) >= (
          select coalesce(start.payload->>'timestamp', start.created_at::text)::timestamptz, start.seq
          from session_events start where start.session_id = p_session_id and start.seq = catalog.latest_spawn_seq)
      order by coalesce(e.payload->>'timestamp', e.created_at::text)::timestamptz desc, e.seq desc limit 1
    ) lifecycle on true;
  return response || jsonb_build_object('snapshot', jsonb_build_object('session', to_jsonb(s), 'approvals', approvals, 'agents', agents));
end;
$$;
revoke all on function read_session_view(uuid, uuid, text, bigint, bigint, bigint, bigint, integer, boolean) from public, anon, authenticated;
grant execute on function read_session_view(uuid, uuid, text, bigint, bigint, bigint, bigint, integer, boolean) to service_role;
