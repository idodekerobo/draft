import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { mintSessionIngestToken } from "../credentials/session-ingest-token";
import { recordRouteError } from "../errors/route-error";

type SessionTokensRequest = Bun.BunRequest<"/workspaces/:id/sessions/tokens">;

interface MintBody {
  // Repo hint (e.g. cwd basename) shown later in a credentials list —
  // purely descriptive, no server behavior keys off it.
  label?: string;
}

function isMintBody(value: unknown): value is MintBody {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const body = value as Partial<MintBody>;
  return body.label === undefined || typeof body.label === "string";
}

export const POST = withAuth<SessionTokensRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  let body: unknown;
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : undefined;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!isMintBody(body)) return Response.json({ error: "invalid_body" }, { status: 400 });

  try {
    const minted = await mintSessionIngestToken(serviceClient, req.params.id, body?.label ?? null);
    return Response.json({ id: minted.id, token: minted.token });
  } catch (err) {
    recordRouteError({
      workspaceId: req.params.id,
      operation: "auth",
      errorCode: "session_token_mint_failed",
      error: err,
    });
    return Response.json({ error: "mint_failed" }, { status: 500 });
  }
});
