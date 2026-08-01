import type {
  OrganizationStatus,
  TeamStatus,
  UserOrgRole,
  UserStatus,
  WorkspaceAccessMode,
  WorkspaceStatus,
} from "./enums";

export interface OrganizationRow {
  id: string;
  slug: string;
  name: string;
  status: OrganizationStatus;
  created_at: string;
  updated_at: string;
}

export interface TeamRow {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  status: TeamStatus;
  created_at: string;
  updated_at: string;
}

export interface UserRow {
  id: string;
  email: string;
  display_name: string | null;
  organization_id: string | null;
  primary_team_id: string | null;
  organization_role: UserOrgRole;
  status: UserStatus;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceRow {
  id: string;
  organization_id: string;
  team_id: string;
  slug: string;
  name: string;
  status: WorkspaceStatus;
  access_mode: WorkspaceAccessMode;
  current_context_version_id: string | null;
  inference_credential_id: string | null;
  runs_enabled: boolean;
  max_runs_per_day: number | null;
  max_cost_usd_per_day: string | null;
  created_at: string;
  updated_at: string;
}
