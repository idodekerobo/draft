-- RLS helper: the calling user's primary_team_id, used by every
-- team-scoped select policy.
create or replace function current_user_team_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select primary_team_id from public.users where id = auth.uid();
$$;
