-- Home sessions belong to one person. Only the owner reads the session, its events and its inputs.
alter table sessions add column is_home boolean not null default false;

create unique index sessions_one_home_per_owner_idx on sessions (workspace_id, owner_user_id)
  where is_home and ended_at is null;

drop policy sessions_select on sessions;
create policy sessions_select on sessions
  for select to authenticated
  using (
    deleted_at is null
    and (not is_home or owner_user_id = auth.uid())
    and exists (
      select 1 from workspaces w
      where w.id = sessions.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

drop policy session_events_select on session_events;
create policy session_events_select on session_events
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = session_events.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
    and exists (
      select 1 from sessions s
      where s.id = session_events.session_id
        and s.workspace_id = session_events.workspace_id
        and (not s.is_home or s.owner_user_id = auth.uid())
    )
  );

drop policy session_inputs_select on session_inputs;
create policy session_inputs_select on session_inputs
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = session_inputs.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
    and exists (
      select 1 from sessions s
      where s.id = session_inputs.session_id
        and s.workspace_id = session_inputs.workspace_id
        and (not s.is_home or s.owner_user_id = auth.uid())
    )
  );
