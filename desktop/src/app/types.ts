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
  | "profile"
  | "intelligence-tools"
  | "scan-import"        // new — T2
  | "integrations"
  | "collab"
  | "consent"
  | "headless-setup"     // new — T6
  | "complete";
