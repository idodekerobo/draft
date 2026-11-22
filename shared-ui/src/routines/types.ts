import type { HarnessId } from "draft-core/harnesses";

export type RoutinePreset = "draft_default" | "hourly" | "daily" | "weekdays" | "weekly" | "custom";
export type RoutineWeekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export interface RoutineLastRun {
  status: string;
  outcome: "changed" | "no_change" | "failure" | "stale" | null;
  completedAt: string | null;
}

export type RoutineRunStatus = "running" | "completed" | "failed" | "skipped";

/** One run of an agent routine. The id opens the run in the session view. */
export interface RoutineRun {
  id: string;
  status: RoutineRunStatus;
  startedAt: string;
  endedAt: string | null;
  result?: string | null;
  /** Why a skipped run did not run, in words for people. */
  skipReason?: string | null;
}

/** What Run now answers. Queued means the run starts when the run in progress ends. Failed means nothing started. */
export type RoutineRunOutcome = { status: "started"; runId: string; sessionId: string } | { status: "queued" } | { status: "failed" };

export type { RoutineEventName } from "draft-core/routines";
import type { RoutineEventName, RoutineListFilter, RoutineWhen } from "draft-core/routines";

/** Opens one run of an agent routine. The routine tells the caller where to come back to. */
export type OpenRun = (sessionId: string, routine: Pick<Routine, "id" | "title">) => void;

/** Set only on agent routines. */
export interface AgentRoutine {
  prompt: string;
  harness: HarnessId;
  /** Alias the harness CLI takes as its model; null for the harness default. */
  model: string | null;
  /** A reasoning effort the model accepts; null for the harness default. */
  reasoningEffort?: string | null;
  createdByName: string | null;
  lastRun: RoutineRun | null;
  canNotify?: boolean;
  /** Lets it search and read the owner's own Gmail. */
  canReadGmail?: boolean;
  /** Whether the routine's owner has their own Gmail connected. A teammate's never counts. */
  ownerGmailConnected?: boolean;
  /** Whether the viewer owns this routine. Only the owner can connect the Gmail it reads. */
  ownedByViewer?: boolean;
  postChannels?: "joined" | string[] | null;
  github?: { repos: string[]; access: "read" | "write" } | null;
  /** The built-in tools of its harness it may use. */
  builtInTools?: string[];
  events?: RoutineEventName[];
  onSchedule?: false;
}

/** One row from GET /workspaces/:id/schedules. */
export interface Routine {
  id: string;
  taskType: string;
  title: string;
  routineDescription: string;
  scheduleDescription: string;
  preset: RoutinePreset;
  time: string | null;
  weekday: RoutineWeekday | null;
  timezone: string;
  cron: string | null;
  intervalSeconds: number | null;
  enabled: boolean;
  editable: "full" | "toggle_only";
  connectionLabel: string | null;
  needsReconnect: boolean;
  nextRunAt: string | null;
  lastCheckedAt: string | null;
  lastRun: RoutineLastRun | null;
  updatedByName: string | null;
  agent: AgentRoutine | null;
  /** One-time, recurring, or triggers only. */
  kind: NonNullable<RoutineListFilter["kind"]>;
  /** When a one-time routine runs, and when it ran. */
  runAt: string | null;
  firedAt: string | null;
  madeByAgent: boolean;
  createdByRunId: string | null;
  createdBySessionId: string | null;
  visibility: "shared" | "private";
  canEdit?: boolean;
}

/** Whether the workspace's routines can run on an agent. A login that stopped working needs a new sign-in. */
export type RoutineAgentStatus = "connected" | "not_connected" | "needs_reconnect";

export interface RoutinesResponse {
  routines: Routine[];
  canEdit: boolean;
  /** By harness id. An agent with no entry is treated as ready. */
  agents?: Partial<Record<string, RoutineAgentStatus>>;
  /** Providers with a live connection, such as "slack". Missing means the form treats every connection as present. */
  connectedProviders?: string[];
  /** Whether the person viewing has their own Gmail connected. Missing means unknown, so the form treats it as connected. */
  gmailConnected?: boolean;
}

/** What a person can change on an agent routine. Send only the fields that changed. */
export interface AgentRoutineEdit {
  title?: string;
  prompt?: string;
  harness?: HarnessId;
  model?: string | null;
  reasoningEffort?: string | null;
  canNotify?: boolean;
  canReadGmail?: boolean;
  postChannels?: "joined" | string[] | null;
  github?: { repos: string[]; access: "read" | "write" } | null;
  builtInTools?: string[];
}

/** When a routine runs: a schedule (null turns it off) and/or triggers. A PATCH leaves an omitted part unchanged. */
export type RoutineRule = Exclude<RoutineWhen, { in: string } | { at: string }>;

/** A schedule a person sets. Only the fields its frequency uses are sent. */
export interface RoutineScheduleInput {
  preset: Exclude<RoutinePreset, "custom">;
  time?: string;
  weekday?: RoutineWeekday;
  timezone?: string;
}

/** Body for PATCH /workspaces/:id/schedules/:taskId. */
export type RoutinePatch = { enabled: boolean } | (AgentRoutineEdit & { when?: RoutineRule });

/** Body for POST /workspaces/:id/schedules: an agent routine and when it runs. */
export interface CreateRoutineInput {
  title: string;
  prompt: string;
  harness: HarnessId;
  model: string | null;
  reasoningEffort?: string | null;
  when: RoutineRule;
  canNotify?: boolean;
  canReadGmail?: boolean;
  postChannels?: "joined" | string[] | null;
  github?: { repos: string[]; access: "read" | "write" } | null;
  builtInTools?: string[];
}
