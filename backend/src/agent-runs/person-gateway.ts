import { z } from "zod";
import { parseUserId, parseWorkspaceId, type UserCallSurface } from "draft-core/agent-run";
import { toHttpResponse } from "./http-result";
import { invokeTool, type InvokeToolDeps } from "./invoke-tool";

/** The tools a person may call, with the JSON schema of each input. */
export function listPersonTools(deps: InvokeToolDeps): Response {
  const tools = deps.registry.listForUser().map((tool) => ({
    name: tool.name,
    access: tool.access,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
  }));
  return Response.json({ tools });
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
  let args: unknown = {};
  if (call.bodyText.trim()) {
    try {
      args = JSON.parse(call.bodyText);
    } catch {
      return Response.json({ status: "invalid", issues: ["body is not valid JSON"] }, { status: 400 });
    }
  }

  let caller;
  try {
    caller = { type: "user" as const, userId: parseUserId(call.userId), workspaceId: parseWorkspaceId(call.workspaceId), via: call.via };
  } catch {
    return Response.json({ error: "workspace_not_found" }, { status: 404 });
  }
  return toHttpResponse(await invokeTool(deps, caller, call.toolName, args));
}
