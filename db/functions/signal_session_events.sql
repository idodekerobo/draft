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
