import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { createInstallSession, getInstallSession } from "../auth/github-install-store";
import { loadConfig } from "../config";

type CreateInstallSessionRequest = Bun.BunRequest<"/workspaces/:id/github/install-sessions">;
type PollInstallSessionRequest = Bun.BunRequest<"/workspaces/:id/github/install-sessions/:code">;

export const createPOST = withAuth<CreateInstallSessionRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const config = loadConfig();
  const code = createInstallSession(req.params.id);
  return Response.json({
    code,
    installUrl: `https://github.com/apps/${config.githubAppSlug}/installations/new?state=${code}`,
  });
});

// Authenticated and workspace-scoped -- unlike link-routes.ts's bare
// pollGET, a leaked code alone must not be sufficient to read status.
export const pollGET = withAuth<PollInstallSessionRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const session = getInstallSession(req.params.code);
  if (session.status === "expired_or_unknown") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  if (session.workspaceId !== req.params.id) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (session.status === "pending") return Response.json({ status: "pending" });
  return Response.json({
    status: session.status,
    errorCode: session.errorCode,
    errorMessage: session.errorMessage,
  });
});
