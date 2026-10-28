import { withAuth } from "./withAuth";
import { serviceClient, publishableClient } from "../db/client";
import { mintDeviceSession } from "./mint-device-session";
import { approvePairing, consumePairing, createPairing } from "./pairing-store";

type LinkCodeRequest = Bun.BunRequest<"/link/:code">;
type LinkApproveRequest = Bun.BunRequest<"/link/:code/approve">;

export async function createPOST(): Promise<Response> {
  return Response.json({ code: createPairing(), expires_in: 300 });
}
export async function pollGET(req: LinkCodeRequest): Promise<Response> {
  const result = consumePairing(req.params.code);
  if (result === "pending") return new Response(null, { status: 204 });
  if (result === "expired_or_unknown") return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(result);
}
export const approvePOST = withAuth<LinkApproveRequest>(async (req, caller) => {
  const tokens = await mintDeviceSession(caller.userId, { admin: serviceClient, anon: publishableClient });
  if (!tokens) return Response.json({ error: "session_mint_failed" }, { status: 500 });
  const ok = approvePairing(req.params.code, tokens);
  return ok ? Response.json({ approved: true }) : Response.json({ error: "expired_or_unknown" }, { status: 404 });
});
