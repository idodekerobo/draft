import { verifyRequest, type VerifiedCaller } from "./verify";

export type AuthedHandler = (
  req: Request,
  caller: VerifiedCaller,
) => Promise<Response> | Response;

export function withAuth(handler: AuthedHandler) {
  return async (req: Request): Promise<Response> => {
    const caller = await verifyRequest(req);
    if (!caller) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return handler(req, caller);
  };
}
