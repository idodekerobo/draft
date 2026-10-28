import { serviceClient } from "../db/client";
import { recordError } from "../errors/record-error";
import { allowOncePer } from "../errors/throttle";
import type { UserRow, WorkspaceRow } from "../types/tables";

const FORBIDDEN_WINDOW_MS = 60_000;

export async function assertWorkspaceAccess(
  workspaceId: string,
  callerId: string,
): Promise<Response | null> {
  const { data: user, error: userErr } = await serviceClient
    .from("users")
    .select("id, organization_id, primary_team_id")
    .eq("id", callerId)
    .maybeSingle<Pick<UserRow, "id" | "organization_id" | "primary_team_id">>();

  if (userErr) {
    console.error("assertWorkspaceAccess: users lookup failed", userErr);
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!user?.primary_team_id) {
    return Response.json({ error: "no_team" }, { status: 404 });
  }

  const { data: workspace, error: wsErr } = await serviceClient
    .from("workspaces")
    .select("organization_id, team_id, access_mode")
    .eq("id", workspaceId)
    .maybeSingle<Pick<WorkspaceRow, "organization_id" | "team_id" | "access_mode">>();

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

  return null;
}
