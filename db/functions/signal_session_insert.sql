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
