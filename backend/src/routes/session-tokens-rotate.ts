import { serviceClient } from "../db/client";
import { rotateSessionIngestToken } from "../credentials/session-ingest-token";
import { recordRouteError } from "../errors/route-error";

type SessionTokensRotateRequest = Bun.BunRequest<"/sessions/tokens/rotate">;

// Credential-gated, not withAuth: authorized by presenting the current
// ingest token itself, the same verification path as /sessions/ingest —
// never a Draft user JWT. Anyone who can read the repo already holds the
// old token, so this is inside the existing trust boundary.
export const POST = async (req: SessionTokensRotateRequest): Promise<Response> => {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return Response.json({ ok: false, error: "missing_ingest_token" }, { status: 401 });
  const ingestToken = authHeader.slice("Bearer ".length).trim();
  if (!ingestToken) return Response.json({ ok: false, error: "missing_ingest_token" }, { status: 401 });

  try {
    const rotated = await rotateSessionIngestToken(serviceClient, ingestToken);
    if (!rotated) return Response.json({ ok: false, error: "invalid_ingest_token" }, { status: 401 });
    return Response.json({ ok: true, id: rotated.id, token: rotated.token });
  } catch (err) {
    recordRouteError({ workspaceId: null, operation: "auth", errorCode: "session_token_rotate_failed", error: err });
    return Response.json({ ok: false, error: "rotate_failed" }, { status: 500 });
  }
};
