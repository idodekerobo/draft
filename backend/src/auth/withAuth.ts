import { verifyRequest, type VerifiedCaller } from "./verify";

export type AuthedHandler<Req extends Request = Request> = (
  req: Req,
  caller: VerifiedCaller,
) => Promise<Response> | Response;

export function withAuth<Req extends Request = Request>(
  handler: AuthedHandler<Req>,
) {
  return async (req: Req): Promise<Response> => {
    const caller = await verifyRequest(req);
    if (!caller) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    return handler(req, caller);
  };
}
