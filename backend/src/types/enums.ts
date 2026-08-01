// Authoritative source for status/role/mode values; DB CHECK is a backstop.

export type OrganizationStatus = "active" | "suspended" | "archived";

export type TeamStatus = "active" | "archived";

export type UserOrgRole = "owner" | "admin" | "member";

export type UserStatus = "invited" | "active" | "disabled";

export type WorkspaceStatus = "active" | "archived";

export type WorkspaceAccessMode = "team_default" | "restricted";

// No DB CHECK constraint backs this one (see db/schemas/credentials.sql) --
// this type is the only source of truth for allowed values.
export type CredentialProvider =
  | "fireflies"
  | "slack"
  | "granola"
  | "claude_code"
  | "reserved_other";

export type CredentialStatus = "active" | "revoked" | "expired";

export type SourceConnectionProvider =
  | "fireflies"
  | "slack"
  | "granola"
  | "claude_session"
  | "codex_session"
  | "reserved_other";

export type SourceConnectionStatus =
  | "pending"
  | "active"
  | "degraded"
  | "revoked"
  | "error";

export type SourceItemType =
  | "transcript"
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
