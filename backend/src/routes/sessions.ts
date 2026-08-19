import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import type { AgentMessageRow, AgentSessionRow, SourceItemRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";

type SessionsRequest = Bun.BunRequest<"/workspaces/:id/sessions">;
type SessionRequest = Bun.BunRequest<"/workspaces/:id/sessions/:sessionId">;

function errorResponse(error: string, status = 500, detail?: unknown, workspaceId?: string): Response {
  if (status >= 500) {
    recordRouteError({ workspaceId: workspaceId ?? null, operation: "read", errorCode: error, error: detail });
  }
  return Response.json({ ok: false, error }, { status });
}

export const GET = withAuth<SessionsRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const url = new URL(req.url);
  const provider = url.searchParams.get("provider");
  const userId = url.searchParams.get("user");
  const since = url.searchParams.get("since");

  let query = serviceClient
    .from("agent_sessions")
    .select("id, provider, user_id, contributor_id, project, cwd, started_at, ended_at, status, summary_status")
    .eq("workspace_id", req.params.id)
    .order("started_at", { ascending: false });
  if (provider) query = query.eq("provider", provider);
  if (userId) query = query.eq("user_id", userId);
  if (since) query = query.gte("started_at", since);

  const { data, error } = await query;
  if (error) return errorResponse("sessions_lookup_failed", 500, error, req.params.id);

  const rows = (data ?? []) as Array<
    Pick<AgentSessionRow, "id" | "provider" | "user_id" | "contributor_id" | "project" | "cwd" | "started_at" | "ended_at" | "status" | "summary_status">
  >;

  const userIds = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => id !== null))];
  const contributorIds = [...new Set(rows.map((r) => r.contributor_id).filter((id): id is string => id !== null))];

  const [usersResult, contributorsResult] = await Promise.all([
    userIds.length > 0
      ? serviceClient.from("users").select("id, display_name, email").in("id", userIds)
      : Promise.resolve({ data: [], error: null }),
    contributorIds.length > 0
      ? serviceClient.from("session_contributors").select("id, git_display_name, git_email").in("id", contributorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (usersResult.error) return errorResponse("users_lookup_failed", 500, usersResult.error, req.params.id);
  if (contributorsResult.error) return errorResponse("contributors_lookup_failed", 500, contributorsResult.error, req.params.id);

  const usersById = new Map(
    ((usersResult.data ?? []) as { id: string; display_name: string | null; email: string }[])
      .map((u) => [u.id, u.display_name ?? u.email]),
  );
  const contributorsById = new Map(
    ((contributorsResult.data ?? []) as { id: string; git_display_name: string | null; git_email: string }[])
      .map((c) => [c.id, c.git_display_name ?? c.git_email]),
  );

  return Response.json({
    sessions: rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      verified: row.user_id !== null,
      display: row.user_id
        ? usersById.get(row.user_id) ?? null
        : row.contributor_id
          ? contributorsById.get(row.contributor_id) ?? null
          : null,
      project: row.project,
      cwd: row.cwd,
      started_at: row.started_at,
      ended_at: row.ended_at,
      status: row.status,
      summary_status: row.summary_status,
      has_summary: row.summary_status === "ok",
    })),
  });
});

async function loadSession(workspaceId: string, sessionId: string): Promise<Pick<AgentSessionRow, "id" | "workspace_id"> | null> {
  const { data } = await serviceClient
    .from("agent_sessions")
    .select("id, workspace_id")
    .eq("id", sessionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle<Pick<AgentSessionRow, "id" | "workspace_id">>();
  return data ?? null;
}

export const READ = withAuth<SessionRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const session = await loadSession(req.params.id, req.params.sessionId);
  // 404 identically for wrong-workspace and nonexistent — never leak that
  // the id exists in a different workspace.
  if (!session) return errorResponse("not_found", 404);

  const url = new URL(req.url);
  const wantsTranscript = url.searchParams.has("transcript");

  if (wantsTranscript) {
    const { data, error } = await serviceClient
      .from("agent_messages")
      .select("seq, role, content, created_at")
      .eq("session_id", session.id)
      .eq("workspace_id", req.params.id)
      .order("seq", { ascending: true });
    if (error) return errorResponse("transcript_lookup_failed", 500, error, req.params.id);
    return Response.json({
      messages: ((data ?? []) as Pick<AgentMessageRow, "seq" | "role" | "content" | "created_at">[]),
    });
  }

  const { data, error } = await serviceClient
    .from("source_items")
    .select("content_markdown, occurred_at, metadata_json")
    .eq("workspace_id", req.params.id)
    .eq("item_type", "coding_session")
    .eq("lifecycle_status", "ready")
    .contains("metadata_json", { agent_session_id: session.id })
    .maybeSingle<Pick<SourceItemRow, "content_markdown" | "occurred_at" | "metadata_json">>();
  if (error) return errorResponse("summary_lookup_failed", 500, error, req.params.id);
  if (!data) return Response.json({ summary: null });

  return Response.json({ summary: data.content_markdown, occurred_at: data.occurred_at });
});
