-- Self-serve onboarding: creates an organization, its default "General" team
-- and a workspace, and makes the caller the owner, in one transaction. The
-- user row is locked first so a double submit cannot create two orgs. Raises
-- 'already_in_organization' when the caller already belongs to one, and lets
-- a unique violation on organizations.slug propagate so the caller can retry
-- with a different slug. Restricted to the backend service role because it
-- accepts an explicit user id.
create or replace function public.create_organization_for_user(
  p_user_id uuid,
  p_org_name text,
  p_org_slug text,
  p_workspace_slug text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing_org uuid;
  v_org_id uuid;
  v_team_id uuid;
  v_workspace_id uuid;
begin
  select organization_id into v_existing_org
  from public.users
  where id = p_user_id
  for update;

  if not found then
    raise exception 'user_not_found';
  end if;
  if v_existing_org is not null then
    raise exception 'already_in_organization';
  end if;

  insert into public.organizations (slug, name)
  values (p_org_slug, p_org_name)
  returning id into v_org_id;

  insert into public.teams (organization_id, slug, name)
  values (v_org_id, 'general', 'General')
  returning id into v_team_id;

  insert into public.workspaces (organization_id, team_id, slug, name)
  values (v_org_id, v_team_id, p_workspace_slug, p_org_name)
  returning id into v_workspace_id;

  update public.users
  set organization_id = v_org_id,
      primary_team_id = v_team_id,
      organization_role = 'owner',
      status = 'active'
  where id = p_user_id;

  return jsonb_build_object(
    'organization_id', v_org_id,
    'team_id', v_team_id,
    'workspace_id', v_workspace_id
  );
end;
$$;

revoke all on function public.create_organization_for_user(uuid, text, text, text) from public;
grant execute on function public.create_organization_for_user(uuid, text, text, text) to service_role;
