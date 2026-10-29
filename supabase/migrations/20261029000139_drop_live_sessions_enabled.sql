-- Live sessions are on for every workspace, so the per-workspace flag is gone.

alter table workspaces
  drop column live_sessions_enabled;
