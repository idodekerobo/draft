import { serviceClient } from "../db/client";
import { revokeSessionIngestTokenWithGrace } from "../credentials/session-ingest-token";
import { recordRouteError } from "../errors/route-error";

type SessionTokensRevokeRequest = Bun.BunRequest<"/sessions/tokens/revoke">;

// Credential-gated, same auth path as rotate — this is what `disable`
// calls. Grace-windows the credential rather than an immediate hard
// revoke, matching rotate's behavior.
export const POST = async (req: SessionTokensRevokeRequest): Promise<Response> => {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return Response.json({ ok: false, error: "missing_ingest_token" }, { status: 401 });
  const ingestToken = authHeader.slice("Bearer ".length).trim();
  if (!ingestToken) return Response.json({ ok: false, error: "missing_ingest_token" }, { status: 401 });

  try {
    const ok = await revokeSessionIngestTokenWithGrace(serviceClient, ingestToken);
    if (!ok) return Response.json({ ok: false, error: "invalid_ingest_token" }, { status: 401 });
    return Response.json({ ok: true });
  } catch (err) {
    recordRouteError({ workspaceId: null, operation: "auth", errorCode: "session_token_revoke_failed", error: err });
    return Response.json({ ok: false, error: "revoke_failed" }, { status: 500 });
  }
};
