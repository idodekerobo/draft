import { callPersonTool, listPersonTools } from "../agent-runs/person-gateway";
import type { InvokeToolDeps } from "../agent-runs/invoke-tool";
import { createDraftToolRegistry } from "../agent-runs/tools";
import { userInvokeDeps } from "../agent-runs/user-gateway";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { isAgentRequest } from "../observability/is-agent-request";

type ToolsRequest = Bun.BunRequest<"/workspaces/:id/tools">;
type ToolRequest = Bun.BunRequest<"/workspaces/:id/tools/:name">;

// Built on first use, once per process: the registry holds no per-caller state.
let deps: InvokeToolDeps | null = null;
function personDeps(): InvokeToolDeps {
  deps ??= userInvokeDeps(serviceClient, createDraftToolRegistry(serviceClient));
  return deps;
}

export const toolsGET = withAuth<ToolsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return listPersonTools(personDeps());
});

// Access to the workspace is checked inside the call, by the same rule MCP uses.
export const toolPOST = withAuth<ToolRequest>(async (req, caller) =>
  callPersonTool(personDeps(), {
    userId: caller.userId,
    workspaceId: req.params.id,
    via: isAgentRequest(req) ? "cli" : "app",
    toolName: req.params.name,
    bodyText: await req.text(),
  }),
);
