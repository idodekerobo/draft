import type { ToolId, ToolStatus } from "./registry";

/** Matches draft-core's normalized HostedConnectionListItem, kept structural to avoid a dependency. */
export interface NormalizedConnection {
  provider: string;
  status: "disconnected" | "pending" | "connected" | "degraded" | "error";
  display_name: string | null;
  is_mine?: boolean;
  account_kind?: "personal" | "workspace";
}

const PERSONAL: ToolId[] = ["fireflies", "granola"];
const TEAM: ToolId[] = ["slack", "github", "linear"];

function toStatus(connection: NormalizedConnection | undefined, pendingText: string): ToolStatus {
  switch (connection?.status) {
    case "connected":
      return { state: "connected", detail: connection.display_name };
    case "degraded":
    case "error":
      return { state: "error", detail: "Needs attention" };
    case "pending":
      return { state: "pending", detail: pendingText };
    default:
      return { state: "disconnected" };
  }
}

/** Personal tools show only the caller's own connection; team tools show the workspace's. */
export function toolStatusesFromConnections(personal: NormalizedConnection[], team: NormalizedConnection[]): Partial<Record<ToolId, ToolStatus>> {
  const statuses: Partial<Record<ToolId, ToolStatus>> = {};
  for (const id of PERSONAL) {
    const mine = personal.find((connection) => connection.provider === id && connection.is_mine && connection.account_kind !== "workspace");
    const workspaceKey = personal.find((connection) => connection.provider === id && connection.account_kind === "workspace" && connection.status === "connected");
    statuses[id] = !mine && workspaceKey ? { state: "connected", detail: "Workspace key" } : toStatus(mine, "Waiting for first meeting");
  }
  for (const id of TEAM) {
    statuses[id] = toStatus(team.find((connection) => connection.provider === id), "Setup pending");
  }
  return statuses;
}
