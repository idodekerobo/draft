import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { type UserCallSurface } from "draft-core/tools";
import { parseToolArgs, toHttpResponse } from "./http-result";
import { invokeTool, type InvokeToolDeps } from "./invoke-tool";
import { describeTools } from "./tool-registry";

/** The tools a person may call, with the JSON schema of each input. */
export function listPersonTools(deps: InvokeToolDeps): Response {
  return Response.json({ tools: describeTools(deps.registry.listForUser()) });
}

export interface PersonToolCall {
  userId: string;
  workspaceId: string;
  via: UserCallSurface;
  toolName: string;
  /** The request body as text. Empty means no input. */
  bodyText: string;
}

/** Calls one tool for a signed-in person and answers as the run endpoint does. */
export async function callPersonTool(deps: InvokeToolDeps, call: PersonToolCall): Promise<Response> {
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
