// sessions-search.ts — GET /workspaces/:id/sessions/search?q=<pattern>
// Searches session summaries (source_items); never returns full content_markdown.

import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { recordRouteError } from "../errors/route-error";
import { resolveUserFilter } from "./sessions-identity";

type SessionsSearchRequest = Bun.BunRequest<"/workspaces/:id/sessions/search">;

interface SearchRow {
  source_item_id: string;
  agent_session_id: string | null;
  provider: string | null;
  user_id: string | null;
  contributor_id: string | null;
  occurred_at: string;
  snippet: string;
}

function errorResponse(error: string, status = 500, detail?: unknown, workspaceId?: string): Response {
  if (status >= 500) {
    recordRouteError({ workspaceId: workspaceId ?? null, operation: "read", errorCode: error, error: detail });
  }
  return Response.json({ ok: false, error }, { status });
}

export const GET = withAuth<SessionsSearchRequest>(async (req, caller) => {
  const denied = await assertWorkspaceAccess(req.params.id, caller.userId);
  if (denied) return denied;

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  if (!q) return errorResponse("missing_query", 400);

  const provider = url.searchParams.get("provider");
  const since = url.searchParams.get("since");
  const userEmail = url.searchParams.get("user");
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const limit = limitParam ? Math.min(100, Math.max(1, Number.parseInt(limitParam, 10) || 20)) : 20;
  const offset = offsetParam ? Math.max(0, Number.parseInt(offsetParam, 10) || 0) : 0;

  let userId: string | null = null;
  let contributorId: string | null = null;
  if (userEmail) {
    const resolved = await resolveUserFilter(serviceClient, req.params.id, userEmail);
    if (resolved.matchedNothing) return Response.json({ sessions: [] });
    userId = resolved.userId;
    contributorId = resolved.contributorId;
  }

  const { data, error } = await serviceClient.rpc("search_source_items", {
    p_workspace_id: req.params.id,
    p_query: q,
    p_since: since,
    p_provider: provider,
    p_user_id: userId,
    p_contributor_id: contributorId,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) return errorResponse("search_failed", 500, error, req.params.id);

  const rows = (data ?? []) as SearchRow[];
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

  const body = {
    sessions: rows.map((row) => ({
      session_id: row.source_item_id,
      agent_session_id: row.agent_session_id,
      provider: row.provider,
      verified: row.user_id !== null,
      display: row.user_id
        ? usersById.get(row.user_id) ?? null
        : row.contributor_id
          ? contributorsById.get(row.contributor_id) ?? null
          : null,
      occurred_at: row.occurred_at,
      snippet: row.snippet,
    })),
  };

  const responseText = JSON.stringify(body);
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "sessions.search",
    argsJson: { q, provider, since, user: userEmail, limit, offset },
    resultBytes: Buffer.byteLength(responseText, "utf8"),
  });
  return new Response(responseText, { headers: { "Content-Type": "application/json" } });
});
