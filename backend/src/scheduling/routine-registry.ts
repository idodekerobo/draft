import type { ScheduledTaskType } from "../types/enums";

export type RoutineEditability = "full" | "toggle_only";

export interface RoutineDefinition {
  title: string;
  routineDescription: string;
  editable: RoutineEditability;
}

// Task types without an entry here (one-time backfills, unimplemented
// rebuilds) are not routines and never reach the Routines tab.
export const ROUTINE_REGISTRY: Partial<Record<ScheduledTaskType, RoutineDefinition>> = {
  synthesize_workspace: {
    title: "Update company context",
    routineDescription:
      "Uses new source material to update the company brain. If there is no new material, the scheduled check does not start a synthesis run.",
    editable: "full",
  },
  summarize_sessions: {
    title: "Summarize coding sessions",
    routineDescription:
      "Turns newly captured coding sessions into summaries that can inform the company brain. Sessions that have already been summarized are skipped.",
    editable: "full",
  },
  ingest_source: {
    title: "Sync Slack",
    routineDescription:
      "Imports new messages from the connected Slack channels as source material for company context. Choose which channels Draft reads in Connections.",
    editable: "toggle_only",
  },
};

export const ROUTINE_TASK_TYPES = Object.keys(ROUTINE_REGISTRY) as ScheduledTaskType[];
