-- Realtime signals: small messages that tell an app "something changed". They carry no content.
-- The app then asks the server for what it needs. Two private topics:
--   signals:session:<session id>   events, inputs and relevant session changes
--   signals:workspace:<workspace id>   a session changed (the sidebar), or context changed
-- Anyone who can see the session or workspace through row security may listen.

-- The id in the current topic, or null when the topic is not "<prefix>:<uuid>".
-- The pattern check makes the cast safe for any other topic.
create or replace function realtime_topic_id(p_prefix text)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when t ~ ('^' || p_prefix || ':[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    then substr(t, length(p_prefix) + 2)::uuid
  end
  from (select realtime.topic() as t) x
$$;

-- Sends one signal. A failed send must never fail the write that caused it.
create or replace function broadcast_signal(p_topic text, p_event text, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(p_payload, p_event, p_topic, true);
exception when others then
  raise warning 'broadcast_signal failed for %: %', p_topic, sqlerrm;
end;
$$;

revoke all on function broadcast_signal(text, text, jsonb) from public, anon, authenticated;

-- New events: one signal per session in the statement, with the highest seq, and one per workspace.
create or replace function signal_session_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select session_id, max(seq) as seq from new_rows group by session_id loop
    perform public.broadcast_signal('signals:session:' || r.session_id, 'events', jsonb_build_object('seq', r.seq));
  end loop;
  for r in select distinct workspace_id from new_rows loop
    perform public.broadcast_signal('signals:workspace:' || r.workspace_id, 'sessions');
  end loop;
  return null;
end;
$$;

create trigger session_events_signal
  after insert on session_events
  referencing new table as new_rows
  for each statement execute function signal_session_events();

-- A message, decision, stop or mode change was created, or moved to another state.
create or replace function signal_session_inputs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select distinct session_id from new_rows loop
    perform public.broadcast_signal('signals:session:' || r.session_id, 'inputs');
  end loop;
  return null;
end;
$$;

create trigger session_inputs_signal_insert
  after insert on session_inputs
  referencing new table as new_rows
  for each statement execute function signal_session_inputs();

create trigger session_inputs_signal_update
  after update on session_inputs
  referencing new table as new_rows
  for each statement execute function signal_session_inputs();

-- A session row changed in a way a viewer can see. The host's heartbeat updates last_seen every 20 s,
-- and appends bump last_seq and last_event_at; those are left out, because new events signal already.
create or replace function signal_session_row()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.broadcast_signal('signals:session:' || new.id, 'session');
  perform public.broadcast_signal('signals:workspace:' || new.workspace_id, 'sessions');
  return null;
end;
$$;

create trigger sessions_signal_update
  after update on sessions
  for each row
  when (
    old.status is distinct from new.status
    or old.title is distinct from new.title
    or old.model is distinct from new.model
    or old.permission_mode is distinct from new.permission_mode
    or old.approval_mode is distinct from new.approval_mode
    or old.open_approval_count is distinct from new.open_approval_count
    or old.end_reason is distinct from new.end_reason
    or old.host_name is distinct from new.host_name
  )
  execute function signal_session_row();

-- A new session appears in the sidebar.
create or replace function signal_session_insert()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.broadcast_signal('signals:workspace:' || new.workspace_id, 'sessions');
  return null;
end;
$$;

create trigger sessions_signal_insert
  after insert on sessions
  for each row execute function signal_session_insert();

-- Context or synthesis changed.
create or replace function signal_workspace_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in select distinct workspace_id from new_rows loop
    perform public.broadcast_signal('signals:workspace:' || r.workspace_id, 'context');
  end loop;
  return null;
end;
$$;

create trigger workspace_events_signal
  after insert on workspace_events
  referencing new table as new_rows
  for each statement execute function signal_workspace_events();

-- Who may listen. These follow the row security of sessions and workspaces.
create policy session_broadcast_select on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (select 1 from public.sessions s where s.id = public.realtime_topic_id('signals:session'))
  );

create policy workspace_broadcast_select on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (select 1 from public.workspaces w where w.id = public.realtime_topic_id('signals:workspace'))
  );
