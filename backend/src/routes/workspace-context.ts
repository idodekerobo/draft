import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { getWorkspaceContext } from "../services/workspace-context";

type ContextRequest = Bun.BunRequest<"/workspaces/:id/context">;

export const contextGET = withAuth<ContextRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const url = new URL(req.url);
  const dimension = url.searchParams.get("dimension") ?? undefined;
  const period = url.searchParams.get("period") ?? undefined;

  const result = await getWorkspaceContext(req.params.id, { dimension, period });
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });

  const body = JSON.stringify(result.snapshot);
  // Browser reads (the web app) carry an Origin header; agent reads (CLI,
  // desktop main process) do not. Only agent reads count as agent usage.
  if (!req.headers.has("origin")) void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "context.read",
    argsJson: { dimension, period },
    resultBytes: body.length,
  });

  return new Response(body, { headers: { "content-type": "application/json" } });
});
