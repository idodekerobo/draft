-- The mirror must never stop synthesis. If copying fails, synthesis goes on and the problem is a warning.
create or replace function mirror_synthesis_run_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform mirror_synthesis_run(new);
  exception when others then
    raise warning 'mirror_synthesis_run failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
