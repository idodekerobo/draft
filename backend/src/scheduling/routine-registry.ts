import type { ScheduledTaskType } from "../types/enums";

export type RoutineEditability = "full" | "toggle_only";

export interface RoutineDefinition {
  title: string;
  routineDescription: string;
  editable: RoutineEditability;
}

// Task types without an entry here (one-time backfills, unimplemented
// rebuilds) are not routines and never reach the Routines tab.
const TASK_ROUTINES: Partial<Record<ScheduledTaskType, RoutineDefinition>> = {
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
};

// ingest_source is shared by every polling provider, so its copy is per provider.
// Webhook providers have no schedule and no entry here.
const SOURCE_ROUTINES: Record<string, RoutineDefinition> = {
  slack: {
    title: "Sync Slack",
    routineDescription:
      "Imports new messages from the connected Slack channels as source material for company context. Choose which channels Draft reads in Connections.",
    editable: "toggle_only",
  },
};

const PROVIDER_NAMES: Record<string, string> = {
  slack: "Slack",
  fireflies: "Fireflies",
  granola: "Granola",
  github: "GitHub",
};

export const ROUTINE_TASK_TYPES: ScheduledTaskType[] = [
  ...(Object.keys(TASK_ROUTINES) as ScheduledTaskType[]),
  "ingest_source",
];

export function resolveRoutine(
  taskType: ScheduledTaskType,
  provider: string | null,
): RoutineDefinition | undefined {
  if (taskType === "ingest_source") return provider ? SOURCE_ROUTINES[provider] : undefined;
  return TASK_ROUTINES[taskType];
}

export function providerName(provider: string): string {
  return PROVIDER_NAMES[provider] ?? provider;
}
