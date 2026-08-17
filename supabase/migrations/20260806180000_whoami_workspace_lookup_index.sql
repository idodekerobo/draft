create index if not exists workspaces_team_id_access_mode_idx
  on public.workspaces (team_id, access_mode);
