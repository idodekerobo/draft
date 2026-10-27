export type MainNavId = "context" | "sessions" | "activity" | "routines" | "connections" | "settings";

export interface MainNavItem {
  id: MainNavId;
  label: string;
}

const MAIN_NAV: MainNavItem[] = [
  { id: "context", label: "Context" },
  { id: "sessions", label: "Sessions" },
  { id: "activity", label: "Activity" },
  { id: "routines", label: "Routines" },
  { id: "connections", label: "Connections" },
  { id: "settings", label: "Settings" },
];

/** The root sidebar entries in display order, for web and desktop. Sessions shows only when the workspace has live sessions on. */
export function mainNavItems(sessionsEnabled: boolean): MainNavItem[] {
  return MAIN_NAV.filter((item) => item.id !== "sessions" || sessionsEnabled);
}
