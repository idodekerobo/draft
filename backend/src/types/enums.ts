// Authoritative source for status/role/mode values; DB CHECK is a backstop.

export type OrganizationStatus = "active" | "suspended" | "archived";

export type TeamStatus = "active" | "archived";

export type UserOrgRole = "owner" | "admin" | "member";

export type UserStatus = "invited" | "active" | "disabled";

export type WorkspaceStatus = "active" | "archived";

export type WorkspaceAccessMode = "team_default" | "restricted";
