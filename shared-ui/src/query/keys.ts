/** Every key starts with the workspace id, so one invalidation clears one workspace. */
export const queryKeys = {
  workspace: (workspaceId: string) => ["ws", workspaceId] as const,
  connectedApps: (workspaceId: string) => ["ws", workspaceId, "connected-apps"] as const,
  runs: (workspaceId: string) => ["ws", workspaceId, "runs"] as const,
  context: (workspaceId: string) => ["ws", workspaceId, "context"] as const,
  connections: (workspaceId: string) => ["ws", workspaceId, "connections"] as const,
  sessionRepos: (workspaceId: string) => ["ws", workspaceId, "session-repos"] as const,
  needsYou: (workspaceId: string) => ["ws", workspaceId, "needs-you"] as const,
  routines: (workspaceId: string) => ["ws", workspaceId, "routines"] as const,
};

/** Starts with the workspace key like the rest, so one invalidation still clears a workspace. */
export const routineRunsKey = (workspaceId: string, routineId: string) => ["ws", workspaceId, "routines", routineId, "runs"] as const;

/** One run with its steps, under the runs key so a run signal refreshes it. */
export const runDetailKey = (workspaceId: string, runId: string) => ["ws", workspaceId, "runs", "detail", runId] as const;
export const runTranscriptKey = (workspaceId: string, runId: string) => ["ws", workspaceId, "runs", "transcript", runId] as const;
