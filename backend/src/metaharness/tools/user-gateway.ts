import type { SupabaseClient } from "@supabase/supabase-js";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { type UserCallSurface } from "draft-core/tools";
import { assertWorkspaceAccess } from "../../auth/workspace-access";
import { auditToDatabase } from "../runs/agent-run-store";
import { parseToolArgs, toHttpResponse } from "./http-result";
import { invokeTool, type AuthorizationDenial, type InvokeToolDeps } from "./invoke-tool";
import { describeTools, type ToolRegistry } from "./tool-registry";

/** A signed-in person may call a tool only if they belong to the workspace's team. This is the one place that rule is applied. */
async function authorizeWorkspaceMember(caller: { userId: string; workspaceId: string }): Promise<AuthorizationDenial | null> {
  const denied = await assertWorkspaceAccess(caller.workspaceId, caller.userId);
  if (!denied) return null;
  return { status: denied.status, body: await denied.json().catch(() => null) };
}

/** What an edge needs to call tools for a person: the registry, the audit, and the access rule. */
export function userInvokeDeps(client: SupabaseClient, registry: ToolRegistry): InvokeToolDeps {
  return { registry, audit: auditToDatabase(client), authorizeUser: authorizeWorkspaceMember };
}

/** The tools a person may call, with the JSON schema of each input. */
export function listUserTools(deps: InvokeToolDeps): Response {
  return Response.json({ tools: describeTools(deps.registry.listForUser()) });
}

export interface UserToolCall {
  userId: string;
  workspaceId: string;
  via: UserCallSurface;
  toolName: string;
  /** The request body as text. Empty means no input. */
  bodyText: string;
}

/** Calls one tool for a signed-in person and answers as the run endpoint does. */
export async function callUserTool(deps: InvokeToolDeps, call: UserToolCall): Promise<Response> {
  const body = parseToolArgs(call.bodyText);
  if (!body.ok) return body.response;

  let caller;
  try {
    caller = { type: "user" as const, userId: parseUserId(call.userId), workspaceId: parseWorkspaceId(call.workspaceId), via: call.via };
  } catch {
    return Response.json({ error: "workspace_not_found" }, { status: 404 });
  }
  return toHttpResponse(await invokeTool(deps, caller, call.toolName, body.args));
}
