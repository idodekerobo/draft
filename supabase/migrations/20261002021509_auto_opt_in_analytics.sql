-- New users start opted in to analytics (replay follows consent), so the
-- separate session_replay_enabled flag is removed. Existing users keep their state.

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, status, organization_role, analytics_consent, analytics_consent_at)
  values (new.id, new.email, 'invited', 'member', true, now())
  on conflict (id) do nothing;
  return new;
end;
$$;

drop function if exists public.get_user_identity(uuid);

alter table public.users drop constraint users_session_replay_requires_consent;
alter table public.users drop column session_replay_enabled;

create or replace function public.get_user_identity(p_user_id uuid)
returns table (
  id uuid,
  email text,
  display_name text,
  organization_id uuid,
  primary_team_id uuid,
  organization_role text,
  status text,
  onboarding_completed_at timestamptz,
  analytics_consent boolean,
  analytics_consent_at timestamptz,
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
    u.onboarding_completed_at,
    u.analytics_consent,
    u.analytics_consent_at,
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
