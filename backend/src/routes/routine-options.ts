import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { listWorkspaceGithubBranches, listWorkspaceGithubRepos } from "../metaharness/tools/definitions/github";
import { recordRouteError } from "../errors/route-error";

type OptionsRequest = Bun.BunRequest<"/workspaces/:id/routine-repositories">;
type BranchesRequest = Bun.BunRequest<"/workspaces/:id/github-branches">;

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

/** The branches of `?repo=owner/name`. `branches` is null when GitHub is not connected or cannot reach the repository. */
export const BRANCHES = withAuth<BranchesRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  const repo = new URL(req.url).searchParams.get("repo") ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return Response.json({ error: "invalid_repo" }, { status: 400 });
  try {
    const found = await listWorkspaceGithubBranches(serviceClient, req.params.id, repo);
    return Response.json(found ?? { branches: null, defaultBranch: null });
  } catch (error) {
    recordRouteError({ workspaceId: req.params.id, operation: "read", errorCode: "github_branches_failed", error });
    return Response.json({ error: "github_branches_failed" }, { status: 502 });
  }
});
