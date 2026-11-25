import { desktopMcp } from "./host/mcp-runtime";
import { getCachedWorkspaceId } from "draft-core/auth-state";
import type { HostServices } from "draft-core/host/services";
import { capture } from "../exec";
import { getDesktopHostId } from "./host/machine-id";
import { openCommandInTerminal } from "./host/open-in-terminal";
import { realtime } from "./realtime/instance";
import { fetchServer, fetchServerJSON } from "./server/server-client";

/** The services the session host runs on, backed by this app's own modules. */
export const desktopHostServices: HostServices = {
  prepareMcp: async (sessionId, workspaceId, hostId, endpointId) => {
    try { return await desktopMcp.prepare({ sessionId, workspaceId, hostId }, endpointId); }
    catch { desktopMcp.status.set(sessionId, { state: "unavailable", reason: "connection_failed" }); return undefined; }
  },
  transferMcp: async (from, sessionId, workspaceId, hostId) => {
    try { await desktopMcp.transfer(from, { sessionId, workspaceId, hostId }); }
    catch { desktopMcp.status.set(sessionId, { state: "unavailable", reason: "connection_failed" }); }
  },
  releaseMcp: (sessionId) => desktopMcp.release(sessionId),
  mcpProblem: (sessionId) => desktopMcp.status.set(sessionId, { state: "unavailable", reason: "connection_failed" }),
  fetchServer,
  fetchServerJSON,
  realtime,
  capture,
  openInTerminal: openCommandInTerminal,
  workspaceId: getCachedWorkspaceId,
  hostId: () => getDesktopHostId(),
};
