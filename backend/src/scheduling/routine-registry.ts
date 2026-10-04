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
    title: "Company context synthesis",
    routineDescription:
      "Uses new source material to update your company context. A check without new material does not start a synthesis run.",
    editable: "full",
  },
  summarize_sessions: {
    title: "Coding session summaries",
    routineDescription: "Summarizes newly captured coding sessions so they can feed your company context.",
    editable: "full",
  },
  ingest_source: {
    title: "Slack import",
    routineDescription:
      "Imports new messages from the selected connected channels as source material. Choose channels in Connections.",
    editable: "toggle_only",
  },
};

export const ROUTINE_TASK_TYPES = Object.keys(ROUTINE_REGISTRY) as ScheduledTaskType[];
