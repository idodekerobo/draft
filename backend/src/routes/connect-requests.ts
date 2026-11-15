import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { INTEGRATIONS, completeConnectRequest, findConnectRequest } from "../integrations/service";

type TokenRequest = Bun.BunRequest<"/connect-requests/:token">;
type CompleteRequest = Bun.BunRequest<"/connect-requests/:token/complete">;

/** What the connect page shows: which provider, for which workspace. Only the person who asked can read it. */
export const GET = withAuth<TokenRequest>(async (req, caller) => {
  try {
    const found = await findConnectRequest(serviceClient, req.params.token, caller.userId);
    if (!found.ok) return Response.json({ error: found.error }, { status: found.error === "already_used" ? 409 : 404 });
    const { data: workspace } = await serviceClient.from("workspaces").select("name").eq("id", found.request.workspace_id).maybeSingle<{ name: string | null }>();
    return Response.json({
      provider: found.request.provider,
      label: INTEGRATIONS.find((entry) => entry.provider === found.request.provider)?.label ?? found.request.provider,
      workspaceId: found.request.workspace_id,
      workspaceName: workspace?.name ?? null,
      expiresAt: found.request.expires_at,
    });
  } catch (error) {
    recordRouteError({ workspaceId: null, operation: "read", errorCode: "connect_request_lookup_failed", error, allowUnattributed: true });
    return Response.json({ error: "lookup_failed" }, { status: 500 });
  }
});

/** Called by the page after the person connected. Closes the link so it can't be used again. */
export const completePOST = withAuth<CompleteRequest>(async (req, caller) => {
  try {
    const found = await findConnectRequest(serviceClient, req.params.token, caller.userId);
    if (!found.ok) return Response.json({ error: found.error }, { status: found.error === "already_used" ? 409 : 404 });
    if (!(await completeConnectRequest(serviceClient, found.request))) return Response.json({ error: "not_connected_yet" }, { status: 409 });
    return Response.json({ status: "completed" });
  } catch (error) {
    recordRouteError({ workspaceId: null, operation: "auth", errorCode: "connect_request_complete_failed", error, allowUnattributed: true });
    return Response.json({ error: "complete_failed" }, { status: 500 });
  }
});
