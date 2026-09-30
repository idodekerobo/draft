import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordRouteError } from "../errors/route-error";
import { loadDisplayNames } from "./session-display-names";

type SessionProjectsRequest = Bun.BunRequest<"/workspaces/:id/sessions/projects">;

interface ProjectRow {
  id: string;
  label: string | null;
  created_at: string;
}

interface CredentialRow {
  session_project_id: string;
  status: string;
  expires_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

interface SessionRow {
  session_project_id: string;
  user_id: string | null;
  contributor_id: string | null;
  started_at: string;
}

function errorResponse(error: string, detail: unknown, workspaceId: string): Response {
  recordRouteError({ workspaceId, operation: "read", errorCode: error, error: detail });
  return Response.json({ ok: false, error }, { status: 500 });
}

// Rotate/disable leave status 'active' and pull expires_at in, so a credential
// is live only while it has not expired.
function isLive(credential: CredentialRow, now: number): boolean {
  if (credential.status !== "active") return false;
  return credential.expires_at === null || new Date(credential.expires_at).getTime() > now;
}

// Repos with capture on, for the whole workspace. Metadata only: no session
// titles or summaries.
export const GET = withAuth<SessionProjectsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;
  const workspaceId = req.params.id;

  const { data: projectData, error: projectError } = await serviceClient
    .from("session_projects")
    .select("id, label, created_at")
    .eq("workspace_id", workspaceId)
    .eq("status", "active");
  if (projectError) return errorResponse("session_projects_lookup_failed", projectError, workspaceId);
  const projects = (projectData ?? []) as ProjectRow[];
  if (projects.length === 0) return Response.json({ projects: [] });
  const projectIds = projects.map((p) => p.id);

  const [credentialResult, sessionResult] = await Promise.all([
    serviceClient
      .from("credentials")
      .select("session_project_id, status, expires_at, created_by_user_id, created_at")
      .eq("workspace_id", workspaceId)
      .eq("provider", "agent_session_ingest")
      .in("session_project_id", projectIds),
    // TODO: aggregate in SQL if a workspace's session volume makes this scan slow.
    serviceClient
      .from("agent_sessions")
      .select("session_project_id, user_id, contributor_id, started_at")
      .eq("workspace_id", workspaceId)
      .in("session_project_id", projectIds)
      .order("started_at", { ascending: false }),
  ]);
  if (credentialResult.error) return errorResponse("credentials_lookup_failed", credentialResult.error, workspaceId);
  if (sessionResult.error) return errorResponse("sessions_lookup_failed", sessionResult.error, workspaceId);
  const credentials = (credentialResult.data ?? []) as CredentialRow[];
  const sessions = (sessionResult.data ?? []) as SessionRow[];

  const now = Date.now();
  const credentialsByProject = Map.groupBy(credentials, (c) => c.session_project_id);
  const sessionsByProject = Map.groupBy(sessions, (s) => s.session_project_id);

  const captureOn = projects.filter((p) => (credentialsByProject.get(p.id) ?? []).some((c) => isLive(c, now)));

  const creatorByProject = new Map<string, string>();
  for (const project of captureOn) {
    const original = (credentialsByProject.get(project.id) ?? [])
      .filter((c) => c.created_by_user_id !== null)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (original?.created_by_user_id) creatorByProject.set(project.id, original.created_by_user_id);
  }

  const captureOnIds = new Set(captureOn.map((p) => p.id));
  const capturedSessions = sessions.filter((s) => captureOnIds.has(s.session_project_id));
  const userIds = [...new Set([
    ...capturedSessions.map((s) => s.user_id),
    ...creatorByProject.values(),
  ].filter((id): id is string => id !== null))];
  const contributorIds = [...new Set(capturedSessions.map((s) => s.contributor_id).filter((id): id is string => id !== null))];

  const names = await loadDisplayNames(serviceClient, userIds, contributorIds);
  if (!names.ok) return errorResponse(names.code, names.detail, workspaceId);

  const body = captureOn.map((project) => {
    const projectSessions = sessionsByProject.get(project.id) ?? [];
    const seen = new Set<string>();
    const contributors: { display: string; is_me: boolean; verified: boolean }[] = [];
    for (const s of projectSessions) {
      const key = s.user_id ? `u:${s.user_id}` : `c:${s.contributor_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const display = s.user_id ? names.users.get(s.user_id) : s.contributor_id ? names.contributors.get(s.contributor_id) : undefined;
      if (!display) continue;
      contributors.push({ display, is_me: s.user_id === caller.userId, verified: s.user_id !== null });
    }

    const creatorId = creatorByProject.get(project.id);
    const creatorDisplay = creatorId ? names.users.get(creatorId) : undefined;

    return {
      id: project.id,
      label: project.label,
      created_at: project.created_at,
      created_by: creatorId && creatorDisplay
        ? { user_id: creatorId, display: creatorDisplay, is_me: creatorId === caller.userId }
        : null,
      last_upload_at: projectSessions[0]?.started_at ?? null,
      session_count: projectSessions.length,
      contributors,
    };
  });

  body.sort((a, b) => (b.last_upload_at ?? "").localeCompare(a.last_upload_at ?? ""));
  return Response.json({ projects: body });
});
