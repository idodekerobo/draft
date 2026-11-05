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
