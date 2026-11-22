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

type GmailRow = { provider: "gmail"; status?: unknown; display_name?: unknown };

/** The caller's own Gmail rows. The connections list never carries a teammate's Gmail. */
function gmailRows(raw: unknown[]): GmailRow[] {
  return raw.filter((row): row is GmailRow => {
    const candidate = row as { provider?: unknown; status?: unknown } | null;
    return typeof candidate === "object" && candidate !== null && candidate.provider === "gmail" && candidate.status !== "revoked";
  });
}

/** True when the caller has Gmail connected, including when it needs a reconnect. */
export function hasGmailConnection(raw: unknown[]): boolean {
  return gmailRows(raw).length > 0;
}

export function gmailToolStatus(raw: unknown[]): ToolStatus {
  const rows = gmailRows(raw);
  if (rows.length === 0) return { state: "disconnected" };
  if (rows.some((row) => row.status === "degraded" || row.status === "error")) return { state: "error", detail: "Reconnect needed" };
  if (rows.some((row) => row.status === "pending")) return { state: "pending", detail: "Waiting for Google" };
  const name = rows.map((row) => row.display_name).find((value): value is string => typeof value === "string" && value.length > 0);
  return { state: "connected", detail: name ? `Connected · ${name}` : "Connected" };
}

type DriveRow = { provider: "google_drive"; status?: unknown };

/** The caller's own Google Drive rows. Like Gmail, the list never carries a teammate's. */
function driveRows(raw: unknown[]): DriveRow[] {
  return raw.filter((row): row is DriveRow => {
    const candidate = row as { provider?: unknown; status?: unknown } | null;
    return typeof candidate === "object" && candidate !== null && candidate.provider === "google_drive" && candidate.status !== "revoked";
  });
}

export function hasDriveConnection(raw: unknown[]): boolean {
  return driveRows(raw).length > 0;
}

/** Synced folder count, or null while it loads or failed to load. */
export function driveToolStatus(raw: unknown[], syncedFolderCount: number | null): ToolStatus {
  const rows = driveRows(raw);
  if (rows.length === 0) return { state: "disconnected" };
  if (rows.some((row) => row.status === "degraded" || row.status === "error")) return { state: "error", detail: "Reconnect needed" };
  if (rows.some((row) => row.status === "pending")) return { state: "pending", detail: "Waiting for Google" };
  if (syncedFolderCount === null) return { state: "connected", detail: "Connected" };
  if (syncedFolderCount === 0) return { state: "pending", detail: "Choose folders", linked: true };
  return { state: "connected", detail: `Connected · ${syncedFolderCount} synced ${syncedFolderCount === 1 ? "folder" : "folders"}` };
}
