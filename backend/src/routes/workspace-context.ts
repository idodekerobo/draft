import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { getWorkspaceContext } from "../services/workspace-context";

type ContextRequest = Bun.BunRequest<"/workspaces/:id/context">;

export const contextGET = withAuth<ContextRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const result = await getWorkspaceContext(req.params.id);
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  const body = JSON.stringify(result.snapshot);
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "context.read",
    argsJson: {},
    resultBytes: body.length,
  });

  return new Response(body, { headers: { "content-type": "application/json" } });
});
