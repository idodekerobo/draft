import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { listWorkspaceGithubRepos } from "../metaharness/tools/definitions/github";
import { recordRouteError } from "../errors/route-error";

type OptionsRequest = Bun.BunRequest<"/workspaces/:id/routine-repositories">;

export const GET = withAuth<OptionsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  try {
    return Response.json({ repos: await listWorkspaceGithubRepos(serviceClient, req.params.id) });
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "read", errorCode: "routine_repositories_failed", error });
    return Response.json({ error: "routine_repositories_failed" }, { status: 502 });
  }
});
