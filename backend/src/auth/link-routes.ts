import { withAuth } from "./withAuth";
import { serviceClient, publishableClient } from "../db/client";
import { mintDeviceSession } from "./mint-device-session";
import { approvePairing, checkPairingConfirm, consumePairing, createPairing, pairingInfo } from "./pairing-store";

type LinkCodeRequest = Bun.BunRequest<"/link/:code">;
type LinkInfoRequest = Bun.BunRequest<"/link/:code/info">;
type LinkApproveRequest = Bun.BunRequest<"/link/:code/approve">;

const MAX_CLIENT_CHARS = 120;

async function jsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Every sign-in gets a code the client shows and the person types on the approval page. */
export async function createPOST(req: Request): Promise<Response> {
  const body = await jsonBody(req);
  const client = typeof body.client === "string" ? body.client.slice(0, MAX_CLIENT_CHARS) : req.headers.get("user-agent")?.slice(0, MAX_CLIENT_CHARS) ?? null;
  const { code, confirmCode } = createPairing({ client });
  return Response.json({ code, confirm_code: confirmCode, expires_in: 300 });
}
export async function pollGET(req: LinkCodeRequest): Promise<Response> {
  const result = consumePairing(req.params.code);
  if (result === "pending") return new Response(null, { status: 204 });
  if (result === "expired_or_unknown") return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(result);
}
/** What the approval page shows: which app asked, and when. */
export const infoGET = withAuth<LinkInfoRequest>(async (req) => {
  const info = pairingInfo(req.params.code);
  if (!info) return Response.json({ error: "expired_or_unknown" }, { status: 404 });
  return Response.json({ client: info.client, requested_at: info.requestedAt });
});
export const approvePOST = withAuth<LinkApproveRequest>(async (req, caller) => {
  const body = await jsonBody(req);
  const checked = checkPairingConfirm(req.params.code, typeof body.confirm_code === "string" ? body.confirm_code : undefined);
  if (checked === "wrong_code") return Response.json({ error: "wrong_code" }, { status: 400 });
  if (checked === "expired_or_unknown") return Response.json({ error: "expired_or_unknown" }, { status: 404 });
  const tokens = await mintDeviceSession(caller.userId, { admin: serviceClient, anon: publishableClient });
  if (!tokens) return Response.json({ error: "session_mint_failed" }, { status: 500 });
  const ok = approvePairing(req.params.code, tokens);
  return ok ? Response.json({ approved: true }) : Response.json({ error: "expired_or_unknown" }, { status: 404 });
});
