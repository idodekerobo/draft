-- Returns the authenticated user's application identity and their team's
-- default workspace in one database query. The function is restricted to the
-- backend service role because it accepts an explicit user id.
create or replace function public.get_user_identity(p_user_id uuid)
returns table (
  id uuid,
  email text,
  display_name text,
  organization_id uuid,
  primary_team_id uuid,
  organization_role text,
  status text,
  workspace_id uuid
)
language sql
security definer
stable
set search_path = public
as $$
  select
    u.id,
    u.email,
    u.display_name,
    u.organization_id,
    u.primary_team_id,
    u.organization_role,
    u.status,
    workspace.id as workspace_id
  from public.users u
  left join lateral (
    select w.id
    from public.workspaces w
    where w.team_id = u.primary_team_id
      and w.organization_id = u.organization_id
      and w.access_mode = 'team_default'
    order by w.created_at asc, w.id asc
    limit 1
  ) workspace on true
  where u.id = p_user_id;
$$;

revoke all on function public.get_user_identity(uuid) from public;
grant execute on function public.get_user_identity(uuid) to service_role;
