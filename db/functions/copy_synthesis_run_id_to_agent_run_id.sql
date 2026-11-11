-- While the old backend can still write a synthesis_run_id, copy it to agent_run_id on insert.
-- A run is in both tables under one id. Dropped with synthesis_run_id when synthesis_runs goes.
create or replace function copy_synthesis_run_id_to_agent_run_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.agent_run_id is null and new.synthesis_run_id is not null
     and exists (select 1 from agent_runs where id = new.synthesis_run_id and workspace_id = new.workspace_id) then
    new.agent_run_id := new.synthesis_run_id;
  end if;
  return new;
end;
$$;

revoke all on function copy_synthesis_run_id_to_agent_run_id() from public;
