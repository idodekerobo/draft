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
