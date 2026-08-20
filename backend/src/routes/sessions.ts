import { withAuth } from "../auth/withAuth";
import { assertWorkspaceAccess } from "../auth/workspace-access";
import { serviceClient } from "../db/client";
import type { AgentMessageRow, AgentSessionRow, SourceItemRow } from "../types/tables";
import { recordRouteError } from "../errors/route-error";
import { recordAgentQueryLog } from "../observability/record-query-log";
import { resolveUserFilter } from "./sessions-identity";

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
  const userEmail = url.searchParams.get("user");
  const since = url.searchParams.get("since");

  let query = serviceClient
    .from("agent_sessions")
    .select("id, provider, user_id, contributor_id, project, cwd, started_at, ended_at, status, summary_status")
    .eq("workspace_id", req.params.id)
    .order("started_at", { ascending: false });
  if (provider) query = query.eq("provider", provider);
  if (since) query = query.gte("started_at", since);

  if (userEmail) {
    const resolved = await resolveUserFilter(serviceClient, req.params.id, userEmail);
    if (resolved.matchedNothing) return Response.json({ sessions: [] });
    const clauses: string[] = [];
    if (resolved.userId) clauses.push(`user_id.eq.${resolved.userId}`);
    if (resolved.contributorId) clauses.push(`contributor_id.eq.${resolved.contributorId}`);
    query = query.or(clauses.join(","));
  }

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

  const body = {
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
  };
  const responseText = JSON.stringify(body);
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "sessions.list",
    argsJson: { provider, user: userEmail, since },
    resultBytes: Buffer.byteLength(responseText, "utf8"),
  });
  return new Response(responseText, { headers: { "Content-Type": "application/json" } });
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

type TranscriptMessage = Pick<AgentMessageRow, "seq" | "role" | "content" | "created_at">;

interface Window {
  start_seq: number;
  end_seq: number;
}

// Merges overlapping/adjacent context windows so the response's `windows`
// field never implies a contiguous transcript when gaps exist between matches.
function mergeWindows(seqs: number[], context: number): Window[] {
  if (seqs.length === 0) return [];
  const sorted = [...seqs].sort((a, b) => a - b);
  const windows: Window[] = [];
  for (const seq of sorted) {
    const start = seq - context;
    const end = seq + context;
    const last = windows[windows.length - 1];
    if (last && start <= last.end_seq + 1) {
      last.end_seq = Math.max(last.end_seq, end);
    } else {
      windows.push({ start_seq: start, end_seq: end });
    }
  }
  return windows;
}

// Drops trailing messages until the serialized array fits maxBytes.
// truncatedBytes reports how many bytes were cut, 0 when nothing was.
function truncateToMaxBytes(messages: TranscriptMessage[], maxBytes: number): { messages: TranscriptMessage[]; truncatedBytes: number } {
  const originalBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  if (originalBytes <= maxBytes) return { messages, truncatedBytes: 0 };
  let truncated = messages;
  while (truncated.length > 0 && Buffer.byteLength(JSON.stringify(truncated), "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }
  return { messages: truncated, truncatedBytes: originalBytes - Buffer.byteLength(JSON.stringify(truncated), "utf8") };
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
    const grep = url.searchParams.get("grep");
    const contextParam = url.searchParams.get("context");
    const context = contextParam ? Math.max(0, Number.parseInt(contextParam, 10) || 0) : 0;
    const maxBytesParam = url.searchParams.get("maxBytes");
    const maxBytes = maxBytesParam ? Number.parseInt(maxBytesParam, 10) : null;

    let windows: Window[] | undefined;
    let messages: TranscriptMessage[];

    if (grep) {
      const { data: matchData, error: matchError } = await serviceClient
        .from("agent_messages")
        .select("seq")
        .eq("session_id", session.id)
        .eq("workspace_id", req.params.id)
        .filter("content", "imatch", grep);
      if (matchError) return errorResponse("invalid_grep_pattern", 400, matchError, req.params.id);

      const matchedSeqs = ((matchData ?? []) as { seq: number }[]).map((r) => r.seq);
      windows = mergeWindows(matchedSeqs, context);

      const { data: fullData, error: fullError } = await serviceClient
        .from("agent_messages")
        .select("seq, role, content, created_at")
        .eq("session_id", session.id)
        .eq("workspace_id", req.params.id)
        .order("seq", { ascending: true });
      if (fullError) return errorResponse("transcript_lookup_failed", 500, fullError, req.params.id);

      const fullMessages = (fullData ?? []) as TranscriptMessage[];
      messages = fullMessages.filter((m) => windows!.some((w) => m.seq >= w.start_seq && m.seq <= w.end_seq));
    } else {
      const { data, error } = await serviceClient
        .from("agent_messages")
        .select("seq, role, content, created_at")
        .eq("session_id", session.id)
        .eq("workspace_id", req.params.id)
        .order("seq", { ascending: true });
      if (error) return errorResponse("transcript_lookup_failed", 500, error, req.params.id);
      messages = (data ?? []) as TranscriptMessage[];
    }

    let truncatedBytes = 0;
    if (maxBytes !== null && maxBytes > 0) {
      const truncated = truncateToMaxBytes(messages, maxBytes);
      messages = truncated.messages;
      truncatedBytes = truncated.truncatedBytes;
    }

    const body: { messages: TranscriptMessage[]; windows?: Window[]; truncated_bytes?: number } = { messages };
    if (windows) body.windows = windows;
    if (truncatedBytes > 0) body.truncated_bytes = truncatedBytes;

    const responseText = JSON.stringify(body);
    void recordAgentQueryLog(serviceClient, {
      workspaceId: req.params.id,
      userId: caller.userId,
      command: "sessions.read",
      argsJson: { sessionId: req.params.sessionId, transcript: true, grep, context, maxBytes },
      resultBytes: Buffer.byteLength(responseText, "utf8"),
    });
    return new Response(responseText, { headers: { "Content-Type": "application/json" } });
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
  if (!data) {
    void recordAgentQueryLog(serviceClient, {
      workspaceId: req.params.id,
      userId: caller.userId,
      command: "sessions.read",
      argsJson: { sessionId: req.params.sessionId, transcript: false },
      resultBytes: 0,
    });
    return Response.json({ summary: null });
  }

  const responseBody = { summary: data.content_markdown, occurred_at: data.occurred_at };
  void recordAgentQueryLog(serviceClient, {
    workspaceId: req.params.id,
    userId: caller.userId,
    command: "sessions.read",
    argsJson: { sessionId: req.params.sessionId, transcript: false },
    resultBytes: Buffer.byteLength(JSON.stringify(responseBody), "utf8"),
  });
  return Response.json(responseBody);
});
