// types.ts — shared app-level domain types
//
// These are domain types that multiple parts of the app reference.

export type View = "context" | "proposals" | "activity" | "settings";

export type DaemonControlVariant =
  | "running"
  | "degraded"
  | "stopped"
  | "starting"
  | "stopping"
  | "restarting";

export type OnboardingStep =
  | "welcome"
  | "cloud-sign-in"
  | "path-choice"         // new — join-team fork, right after welcome
  | "profile"
  | "intelligence-tools"
  | "scan-import"        // new — T2
  | "integrations"
  | "collab"
  | "join-team"           // new — native GitHub OAuth join, replaces "collab" on the join path
  | "consent"
  | "headless-setup"     // new — T6
  | "complete";

export type OnboardingPath = "solo" | "join";
