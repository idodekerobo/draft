// types.ts — shared app-level domain types
//
// These are domain types that multiple parts of the app reference.

export type View = "context" | "proposals" | "settings";

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
  | "inputs"
  | "collab"
  | "consent"
  | "complete";
