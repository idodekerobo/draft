/** Every key starts with the workspace id, so one invalidation clears one workspace. */
export const queryKeys = {
  workspace: (workspaceId: string) => ["ws", workspaceId] as const,
  connectedApps: (workspaceId: string) => ["ws", workspaceId, "connected-apps"] as const,
  runs: (workspaceId: string) => ["ws", workspaceId, "runs"] as const,
  context: (workspaceId: string) => ["ws", workspaceId, "context"] as const,
  connections: (workspaceId: string) => ["ws", workspaceId, "connections"] as const,
  sessionRepos: (workspaceId: string) => ["ws", workspaceId, "session-repos"] as const,
  routines: (workspaceId: string) => ["ws", workspaceId, "routines"] as const,
};
