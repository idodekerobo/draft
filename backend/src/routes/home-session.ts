import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { claudeCredentialRules } from "../cloud-sessions/claude-credential";
import { credentialStatus } from "../credentials/harness-credential";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { homeModelCatalog } from "../home/models";
import { ensureHomeSession } from "../home/session";

type SessionRequest = Bun.BunRequest<"/workspaces/:id/home/session">;
type ModelsRequest = Bun.BunRequest<"/workspaces/:id/home/models">;

/**
 * The caller's own Home session, made on first use, and whether Home can reply now. Home is private to its owner, so nobody can
 * ask for another person's. It cannot reply when the workspace has no usable Claude login.
 */
export const GET = withAuth<SessionRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  try {
    const session = await ensureHomeSession(serviceClient, { workspaceId: req.params.id, ownerUserId: caller.userId });
    const login = await credentialStatus(serviceClient, req.params.id, claudeCredentialRules);
    return Response.json({
      ok: true,
      session: { id: session.id, model: session.model, status: session.status, started_at: session.started_at },
      can_reply: login === "active",
    });
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "session", errorCode: "home_session_failed", error });
    return Response.json({ ok: false, error: "home_session_failed" }, { status: 500 });
  }
});

/** The models a person can pick for Home. A model their account cannot use fails with the provider's own reason when it is tried. */
export const MODELS = withAuth<ModelsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  return Response.json({ ok: true, provider: "anthropic", models: homeModelCatalog("anthropic") });
});
