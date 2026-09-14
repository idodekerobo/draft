-- Allocates the next workspace_events.sequence_number, locking the
-- workspace row first so concurrent writers across the codebase (this
-- function, commit_synthesis_run) can never collide on the same number.
create or replace function next_workspace_event_sequence(p_workspace_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next bigint;
begin
  perform 1 from workspaces where id = p_workspace_id for update;
  select coalesce(max(sequence_number), 0) + 1 into v_next
  from workspace_events where workspace_id = p_workspace_id;
  return v_next;
end;
$$;

revoke all on function next_workspace_event_sequence(uuid) from public;
grant execute on function next_workspace_event_sequence(uuid) to service_role;
