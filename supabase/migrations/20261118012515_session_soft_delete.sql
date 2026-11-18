-- A deleted session stays in the table but no viewer sees it. Only the owner can delete.
-- The host's local files are not touched; this only hides the row in Draft.
alter table sessions add column deleted_at timestamptz;

-- Signed-in clients that read the table directly must not see deleted rows either.
drop policy sessions_select on sessions;
create policy sessions_select on sessions
  for select to authenticated
  using (
    deleted_at is null
    and exists (
      select 1 from workspaces w
      where w.id = sessions.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

-- Other viewers' lists must drop the session at once, so a delete signals.
drop trigger sessions_signal_update on sessions;
create trigger sessions_signal_update
  after update on sessions
  for each row
  when (
    old.status is distinct from new.status
    or old.title is distinct from new.title
    or old.model is distinct from new.model
    or old.reasoning_effort is distinct from new.reasoning_effort
    or old.permission_mode is distinct from new.permission_mode
    or old.approval_mode is distinct from new.approval_mode
    or old.open_approval_count is distinct from new.open_approval_count
    or old.end_reason is distinct from new.end_reason
    or old.host_name is distinct from new.host_name
    or old.deleted_at is distinct from new.deleted_at
  )
  execute function signal_session_row();
