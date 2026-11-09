import type { SupabaseClient } from "@supabase/supabase-js";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { auditToDatabase } from "./agent-run-store";
import type { AuthorizationDenial, InvokeToolDeps } from "./invoke-tool";
import type { ToolRegistry } from "./tool-registry";

/** A signed-in person may call a tool only if they belong to the workspace's team. This is the one place that rule is applied. */
export async function authorizeWorkspaceMember(caller: { userId: string; workspaceId: string }): Promise<AuthorizationDenial | null> {
  const denied = await assertWorkspaceAccess(caller.workspaceId, caller.userId);
  if (!denied) return null;
  return { status: denied.status, body: await denied.json().catch(() => null) };
}

/** What an edge needs to call tools for a person: the registry, the audit, and the access rule. */
export function userInvokeDeps(client: SupabaseClient, registry: ToolRegistry): InvokeToolDeps {
  return { registry, audit: auditToDatabase(client), authorizeUser: authorizeWorkspaceMember };
}
