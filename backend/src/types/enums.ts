// Authoritative source for status/role/mode values; DB CHECK is a backstop.

export type OrganizationStatus = "active" | "suspended" | "archived";

export type TeamStatus = "active" | "archived";

export type UserOrgRole = "owner" | "admin" | "member";

export type UserStatus = "invited" | "active" | "disabled";

export type InviteStatus = "active" | "revoked" | "expired";

export type WorkspaceStatus = "active" | "archived";

export type WorkspaceAccessMode = "team_default" | "restricted";

// No DB CHECK constraint backs this one (see db/schemas/credentials.sql) --
// this type is the only source of truth for allowed values.
// "claude_session_ingest" is the legacy (pre Plan-0049) workspace-scoped
// ingest provider -- kept only so old rows still type-check. New code mints
// "agent_session_ingest" (project + provider scoped) exclusively.
export type CredentialProvider =
  | "fireflies"
  | "slack"
  | "granola"
  | "linear"
  | "github"
  | "claude_code"
  | "claude_session_ingest"
  | "agent_session_ingest";

export type CredentialStatus = "active" | "revoked" | "expired";

// Providers an agent_session_ingest credential may submit sessions under --
// these are the literal `source` query-param values sessions-ingest.ts
// compares against, not display names.
export type AgentSessionProvider = "claude-code-session" | "codex-session";

export type SourceConnectionProvider =
  | "fireflies"
  | "slack"
  | "granola"
  | "linear"
  | "github"
  | "claude_session"
  | "codex_session"
  | "manual_upload";

export type SourceConnectionStatus =
  | "pending"
  | "active"
  | "degraded"
  | "revoked"
  | "error";

export type SourceItemType =
  | "meeting_transcript"
  | "meeting_notes"
  | "message"
  | "coding_session"
  | "document"
  | "provider_event";

export type SourceItemLifecycleStatus =
  | "received"
  | "normalized"
  | "ready"
  | "superseded"
  | "deleted"
  | "quarantined";

export type ContextVersionCreationReason =
  | "seed"
  | "synthesis"
  | "manual_edit"
  | "restore";

export type ScheduledTaskType =
  | "ingest_source"
  | "synthesize_workspace"
  | "rebuild_projection"
  | "summarize_sessions";

export type ScheduleKind = "cron" | "interval";

export type SynthesisRunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "validating"
  | "committing"
  | "succeeded"
  | "failed"
  | "stale"
  | "cancelled";

export type SynthesisRunTriggerType =
  | "schedule"
  | "source_threshold"
  | "manual"
  | "retry"
  | "stale_requeue"
  | "seed_test";

export type SynthesisRunOutcome = "changed" | "no_change" | "failure" | "stale";

export type WorkspaceEventType =
  | "source_items_added"
  | "context_updated"
  | "no_change"
  | "needs_input"
  | "input_resolved"
  | "source_delayed"
  | "context_restored"
  | "manual_edit";

export type AgentSessionSummaryStatus =
  | "pending"
  | "leased"
  | "ok"
  | "failed"
  | "skipped";

export type ErrorOperation =
  | "ingestion"
  | "scheduling"
  | "queue"
  | "execution"
  | "validation"
  | "commit"
  | "projection"
  | "auth"
  | "read";
