import { serviceClient } from "../db/client";
import { recordError } from "../errors/record-error";
import { allowOncePer } from "../errors/throttle";
import type { UserRow, WorkspaceRow } from "../types/tables";

const FORBIDDEN_WINDOW_MS = 60_000;
// A passed check is trusted this long, so a person removed from a team keeps access for up to this long.
const ALLOWED_TTL_MS = 30_000;
const MAX_ALLOWED = 5_000;
let allowed = new Map<string, number>();

export function resetAccessCacheForTests(): void {
  allowed = new Map();
}

export async function assertWorkspaceAccess(
  workspaceId: string,
  callerId: string,
): Promise<Response | null> {
  const key = `${workspaceId}:${callerId}`;
  if ((allowed.get(key) ?? 0) > Date.now()) return null;

  const [userResult, workspaceResult] = await Promise.all([
    serviceClient
      .from("users")
      .select("id, organization_id, primary_team_id")
      .eq("id", callerId)
      .maybeSingle<Pick<UserRow, "id" | "organization_id" | "primary_team_id">>(),
    serviceClient
      .from("workspaces")
      .select("organization_id, team_id, access_mode")
      .eq("id", workspaceId)
      .maybeSingle<Pick<WorkspaceRow, "organization_id" | "team_id" | "access_mode">>(),
  ]);

  const { data: user, error: userErr } = userResult;
  if (userErr) {
    console.error("assertWorkspaceAccess: users lookup failed", userErr);
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!user?.primary_team_id) {
    return Response.json({ error: "no_team" }, { status: 404 });
  }

  const { data: workspace, error: wsErr } = workspaceResult;
  if (wsErr) {
    console.error("assertWorkspaceAccess: workspaces lookup failed", wsErr);
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!workspace) return Response.json({ error: "not_found" }, { status: 404 });

  if (
    workspace.organization_id !== user.organization_id ||
    workspace.team_id !== user.primary_team_id ||
    workspace.access_mode !== "team_default"
  ) {
    if (allowOncePer(`forbidden:${workspaceId}:${callerId}`, FORBIDDEN_WINDOW_MS)) {
      void recordError({ workspaceId, operation: "auth", message: "workspace access forbidden", code: "forbidden", detail: { caller_id: callerId } });
    }
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  if (allowed.size >= MAX_ALLOWED) allowed = new Map();
  allowed.set(key, Date.now() + ALLOWED_TTL_MS);
  return null;
}
