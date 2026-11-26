import { isChoosableModelProvider, MODEL_PROVIDERS } from "draft-core/model-provider";
import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { isAdmin } from "../people/decide";

type Request = Bun.BunRequest<"/workspaces/:id/model-provider">;

function failure(error: string, status: number, detail?: unknown, workspaceId?: string): Response {
  if (status >= 500) recordRouteError({ workspaceId: workspaceId ?? null, operation: "auth", errorCode: error, error: detail });
  return Response.json({ ok: false, error }, { status });
}

/** The AI lab the workspace picked for Draft's agent, and whether this person may change it. */
export const GET = withAuth<Request>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  try {
    const { data, error } = await serviceClient.from("workspaces").select("default_model_provider").eq("id", req.params.id).maybeSingle();
    if (error) throw error;
    if (!data) return failure("workspace_not_found", 404);
    return Response.json({
      ok: true,
      provider: (data as { default_model_provider: string }).default_model_provider,
      can_edit: await isAdmin(serviceClient, caller.userId),
      providers: MODEL_PROVIDERS,
    });
  } catch (error) {
    return failure("model_provider_lookup_failed", 500, error, req.params.id);
  }
});

/** Changes the workspace's AI lab. Only an organization owner or admin may, because it decides which login every Home uses. */
export const PUT = withAuth<Request>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return failure("invalid_json", 400);
  }
  const provider = (body as { provider?: unknown } | null)?.provider;
  if (!isChoosableModelProvider(provider)) return failure("invalid_provider", 400);

  try {
    if (!(await isAdmin(serviceClient, caller.userId))) return failure("not_admin", 403);
    const { error } = await serviceClient.from("workspaces").update({ default_model_provider: provider }).eq("id", req.params.id);
    if (error) throw error;
    return Response.json({ ok: true, provider });
  } catch (error) {
    return failure("model_provider_save_failed", 500, error, req.params.id);
  }
});
