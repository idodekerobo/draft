import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { ensureHomeSession } from "../home/session";

type Request = Bun.BunRequest<"/workspaces/:id/home/session">;

/** The caller's own Home session, made on first use. Home is private to its owner, so nobody can ask for another person's. */
export const GET = withAuth<Request>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  try {
    const session = await ensureHomeSession(serviceClient, { workspaceId: req.params.id, ownerUserId: caller.userId });
    return Response.json({ ok: true, session: { id: session.id, model: session.model, status: session.status, started_at: session.started_at } });
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "session", errorCode: "home_session_failed", error });
    return Response.json({ ok: false, error: "home_session_failed" }, { status: 500 });
  }
});
