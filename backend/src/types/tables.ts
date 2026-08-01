import type {
  ContextVersionCreationReason,
  CredentialProvider,
  CredentialStatus,
  ErrorOperation,
  OrganizationStatus,
  ScheduleKind,
  ScheduledTaskType,
  SourceConnectionProvider,
  SourceConnectionStatus,
  SourceItemLifecycleStatus,
  SourceItemType,
  SynthesisRunOutcome,
  SynthesisRunStatus,
  SynthesisRunTriggerType,
  TeamStatus,
  UserOrgRole,
  UserStatus,
  WorkspaceAccessMode,
  WorkspaceEventType,
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

// Append-only: no updated_at.
export interface WorkspaceContextVersionRow {
  id: string;
  workspace_id: string;
  version_number: number;
  previous_version_id: string | null;
  documents_json: Record<string, { content: string; sha256: string }>;
  content_hash: string;
  creation_reason: ContextVersionCreationReason;
  synthesis_run_id: string | null;
  restored_from_version_id: string | null;
  summary: string;
  created_at: string;
}

export interface ScheduledTaskRow {
  id: string;
  workspace_id: string;
  source_connection_id: string | null;
  task_type: ScheduledTaskType;
  task_key: string;
  schedule_kind: ScheduleKind;
  cron_expression: string | null;
  interval_seconds: number | null;
  timezone: string;
  enabled: boolean;
  config_json: Record<string, unknown>;
  next_due_at: string | null;
  last_enqueued_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SynthesisRunRow {
  id: string;
  workspace_id: string;
  scheduled_task_id: string | null;
  retry_of_run_id: string | null;
  idempotency_key: string;
  status: SynthesisRunStatus;
  trigger_type: SynthesisRunTriggerType;
  base_context_version_id: string;
  attempt: number;
  prompt_version: string;
  outcome: SynthesisRunOutcome | null;
  result_summary: string | null;
  result_hash: string | null;
  needs_input_json: unknown[] | null;
  needs_input_resolution: string | null;
  needs_input_resolved_at: string | null;
  needs_input_resolved_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Immutable membership row: no updated_at.
export interface SynthesisRunSourceItemRow {
  workspace_id: string;
  synthesis_run_id: string;
  source_item_id: string;
  position: number;
  source_item_version: string;
  content_hash: string;
  created_at: string;
}

// Immutable feed row: no updated_at.
export interface WorkspaceEventRow {
  id: string;
  workspace_id: string;
  sequence_number: number;
  event_type: WorkspaceEventType;
  synthesis_run_id: string | null;
  source_connection_id: string | null;
  context_version_id: string | null;
  summary: string;
  payload_json: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
}

// Dumb append-only log row: no updated_at, no status.
export interface ErrorRow {
  id: string;
  workspace_id: string;
  source_connection_id: string | null;
  scheduled_task_id: string | null;
  synthesis_run_id: string | null;
  operation: ErrorOperation;
  message: string;
  detail_json: Record<string, unknown>;
  stack_trace: string | null;
  created_at: string;
}
