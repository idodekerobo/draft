-- Restrict pilot reads to the authenticated user's primary team as well as
-- their organization. Organizations remain organization-scoped.

create or replace function current_user_team_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select primary_team_id from public.users where id = auth.uid();
$$;

-- The pilot client is read-only. These grants allow RLS to evaluate reads;
-- tables absent from this list remain unavailable to authenticated clients.
grant select on table
  organizations,
  teams,
  users,
  workspaces,
  source_connections,
  source_items,
  workspace_context_versions,
  synthesis_runs,
  workspace_events,
  errors,
  slack_messages
to authenticated;

-- Trusted API and worker processes use the service role. RLS is not their
-- boundary; workspace-qualified code and composite foreign keys are.
grant select on table
  workspaces,
  credentials,
  workspace_context_versions
to service_role;

grant select, insert, update on table
  source_connections,
  source_items,
  scheduled_tasks,
  synthesis_runs,
  slack_messages
to service_role;

grant select, insert on table
  synthesis_run_source_items,
  workspace_events
to service_role;

grant insert on table errors to service_role;

drop policy if exists teams_select on teams;
create policy teams_select on teams
  for select to authenticated
  using (
    organization_id = current_user_org_id()
    and id = current_user_team_id()
  );

drop policy if exists users_select on users;
create policy users_select on users
  for select to authenticated
  using (
    organization_id = current_user_org_id()
    and primary_team_id = current_user_team_id()
  );

drop policy if exists workspaces_select on workspaces;
create policy workspaces_select on workspaces
  for select to authenticated
  using (
    organization_id = current_user_org_id()
    and team_id = current_user_team_id()
    and access_mode = 'team_default'
  );

drop policy if exists source_connections_select on source_connections;
create policy source_connections_select on source_connections
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = source_connections.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

drop policy if exists source_items_select on source_items;
create policy source_items_select on source_items
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = source_items.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

drop policy if exists workspace_context_versions_select on workspace_context_versions;
create policy workspace_context_versions_select on workspace_context_versions
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = workspace_context_versions.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

drop policy if exists synthesis_runs_select on synthesis_runs;
create policy synthesis_runs_select on synthesis_runs
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = synthesis_runs.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

drop policy if exists workspace_events_select on workspace_events;
create policy workspace_events_select on workspace_events
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = workspace_events.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

drop policy if exists errors_select on errors;
create policy errors_select on errors
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = errors.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

drop policy if exists slack_messages_select on slack_messages;
create policy slack_messages_select on slack_messages
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = slack_messages.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );
