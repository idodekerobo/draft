import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRunSpec } from "draft-core/run-spec";

/** The user the run acts for left the workspace or was disabled, so the run must not start. */
export class PrincipalInactiveError extends Error {
  readonly code = "principal_inactive";
  constructor(userId: string) {
    super(`User ${userId} is no longer an active member of the workspace`);
  }
}

/**
 * A run that acts for a user may start only while that user is active and still on the workspace's team,
 * the same membership test as `assertWorkspaceAccess`. A run for no one has nobody to check.
 */
export async function assertPrincipalActive(client: SupabaseClient, spec: Pick<AgentRunSpec, "onBehalfOf" | "workspaceId">): Promise<void> {
  const userId = spec.onBehalfOf;
  if (!userId) return;

  const { data: user, error: userError } = await client.from("users").select("status, primary_team_id").eq("id", userId).maybeSingle();
  if (userError) throw userError;
  const { data: workspace, error: workspaceError } = await client.from("workspaces").select("team_id").eq("id", spec.workspaceId).maybeSingle();
  if (workspaceError) throw workspaceError;

  const member = user?.status === "active" && !!workspace?.team_id && user.primary_team_id === workspace.team_id;
  if (!member) throw new PrincipalInactiveError(userId);
}
