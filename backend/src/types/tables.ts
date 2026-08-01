import type {
  CredentialProvider,
  CredentialStatus,
  OrganizationStatus,
  SourceConnectionProvider,
  SourceConnectionStatus,
  SourceItemLifecycleStatus,
  SourceItemType,
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

// `encrypted_payload` is deliberately omitted -- only the service role can select it
// this row type may run against the user/publishable client
export interface CredentialRow {
  id: string;
  workspace_id: string;
  provider: CredentialProvider;
  label: string | null;
  encryption_key_version: string;
  status: CredentialStatus;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceConnectionRow {
  id: string;
  workspace_id: string;
  provider: SourceConnectionProvider;
  connection_key: string;
  display_name: string | null;
  external_account_id: string | null;
  status: SourceConnectionStatus;
  credential_id: string | null;
  config_json: Record<string, unknown>;
  cursor_json: Record<string, unknown>;
  connected_by_user_id: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceItemRow {
  id: string;
  workspace_id: string;
  source_connection_id: string;
  item_type: SourceItemType;
  external_id: string;
  external_version: string;
  lifecycle_status: SourceItemLifecycleStatus;
  occurred_at: string;
  received_at: string;
  normalized_at: string | null;
  content_markdown: string | null;
  content_hash: string | null;
  metadata_json: Record<string, unknown>;
  sanitized_raw_json: unknown | null;
  supersedes_source_item_id: string | null;
  created_at: string;
  updated_at: string;
}
