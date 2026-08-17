import { withAuth } from "./withAuth";
import { approvePairing, consumePairing, createPairing, type PairingTokens } from "./pairing-store";

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
  const code = req.params.code;
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const value = body as Partial<PairingTokens>;
  if (typeof value.refresh_token !== "string" || !value.refresh_token ||
      (value.expires_at !== undefined && typeof value.expires_at !== "number") ||
      (value.expires_in !== undefined && typeof value.expires_in !== "number")) {
    return Response.json({ error: "invalid_tokens" }, { status: 400 });
  }
  const ok = approvePairing(code, { access_token: caller.accessToken, refresh_token: value.refresh_token, expires_at: value.expires_at, expires_in: value.expires_in });
  return ok ? Response.json({ approved: true }) : Response.json({ error: "expired_or_unknown" }, { status: 404 });
});
