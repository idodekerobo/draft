import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { codexCredentialStatus, parseCodexAuthJson, saveCodexCredential } from "../credentials/codex-credential";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";

type Request = Bun.BunRequest<"/workspaces/:id/codex-credential">;

const MAX_BODY_BYTES = 128 * 1024;

function failure(error: string, status: number, detail?: unknown, workspaceId?: string): Response {
  if (status >= 500) recordRouteError({ workspaceId: workspaceId ?? null, operation: "auth", errorCode: error, error: detail });
  return Response.json({ ok: false, error }, { status });
}

/** Whether the workspace has a Codex login for routines. Never returns the login. */
export const GET = withAuth<Request>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  try {
    return Response.json({ ok: true, status: await codexCredentialStatus(serviceClient, req.params.id) });
  } catch (error) {
    return failure("credential_lookup_failed", 500, error, req.params.id);
  }
});

/** Saves the Codex login the workspace's routines run with. Any member of the workspace may connect it. */
export const PUT = withAuth<Request>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return failure("body_too_large", 413);
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return failure("invalid_json", 400);
  }
  const authJson = parseCodexAuthJson((body as { auth_json?: unknown } | null)?.auth_json);
  if (!authJson) return failure("invalid_auth_json", 400);

  try {
    await saveCodexCredential(serviceClient, req.params.id, authJson, caller.userId);
    return Response.json({ ok: true });
  } catch (error) {
    return failure("credential_save_failed", 500, error, req.params.id);
  }
});
