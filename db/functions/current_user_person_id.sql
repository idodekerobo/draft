-- The calling user's person in a workspace. people has no select policy, so RLS reads it through this function.
create or replace function current_user_person_id(p_workspace_id uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from public.people where workspace_id = p_workspace_id and user_id = auth.uid();
$$;

revoke all on function current_user_person_id(uuid) from public;
grant execute on function current_user_person_id(uuid) to authenticated, service_role;
