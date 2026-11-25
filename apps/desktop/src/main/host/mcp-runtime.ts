import { afterMcpRestored } from "./mcp-recovery";
import { getCachedWorkspaceId, getFreshAccessToken } from "draft-core/auth-state";
import { loadStates } from "draft-core/host/cursor-store";
import { apiUrl } from "../server/server-client";
import { SessionMcpBridge, hostMcpDir } from "./mcp-bridge";
import { createSessionMcpTransport } from "./mcp-transport";

export const desktopMcp = new SessionMcpBridge({
  directory: hostMcpDir(), apiUrl, workspaceId: getCachedWorkspaceId,
  send: createSessionMcpTransport({ apiUrl, fetch,
    token: (forceRefresh) => getFreshAccessToken({
      supabaseUrl: process.env.DRAFT_SUPABASE_URL ?? "",
      publishableKey: process.env.DRAFT_SUPABASE_PUBLISHABLE_KEY ?? "", forceRefresh,
    }),
  }),
});

let restoring: Promise<void> | null = null;
export function restoreDesktopMcp(): Promise<void> {
  if (restoring) return restoring;
  restoring = (async () => {
    if (!getCachedWorkspaceId()) return;
    try { await desktopMcp.restore(); } catch {
      for (const state of loadStates()) {
        if (!state.ended && state.workspaceId === getCachedWorkspaceId()) desktopMcp.status.set(state.sessionId, { state: "unavailable", reason: "connection_failed" });
      }
      return;
    }
    for (const state of loadStates()) {
      if (!state.ended && state.workspaceId === getCachedWorkspaceId()) {
        try { await desktopMcp.prepare({ sessionId: state.sessionId, workspaceId: state.workspaceId, hostId: state.hostId }, state.harness === "claude" ? state.hookId ?? state.sessionId : state.sessionId); } catch { desktopMcp.status.set(state.sessionId, { state: "unavailable", reason: "connection_failed" }); }
      }
    }
  })().finally(() => { restoring = null; });
  return restoring;
}

export function withDesktopMcp<T>(recover: () => Promise<T> | T): Promise<T> {
  return afterMcpRestored(restoreDesktopMcp, recover);
}
