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
