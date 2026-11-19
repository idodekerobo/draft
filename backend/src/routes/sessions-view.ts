import { withAuth } from "../auth/withAuth";
import { serviceClient } from "../db/client";
import { loadDisplayNames } from "./session-display-names";
import { loadSessionLinks, loadTurnAuthors, loadRecentAuthors } from "./sessions-live";
import { loadViewerInputs } from "./sessions-live-inputs";
import { authorize, errorResponse, knownDbError, SESSION_COLUMNS } from "./sessions-live-shared";
import type { SessionRow } from "../types/tables";
import type { SessionTranscriptPage, SessionAgentSummary, LiveSessionEvent } from "draft-core/live-sessions";

type ViewRequest = Bun.BunRequest<"/workspaces/:id/live-sessions/:sessionId/view">;

export function parseViewQuery(params: URLSearchParams): (Partial<Record<"before" | "after" | "around" | "through" | "limit", number>> & { agentId: string | null; state: boolean }) | null {
  const values: Record<string, number> = {};
  for (const key of ["before", "after", "around", "through", "limit"]) {
    const value = params.get(key);
    if (value === null) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return null;
    values[key] = Number(value);
  }
  if (["before", "after", "around"].filter((key) => key in values).length > 1) return null;
  const agentId = params.get("agentId");
  if (agentId !== null && !/^[A-Za-z0-9_-]{1,200}$/.test(agentId)) return null;
  if (params.has("state") && !["true", "false"].includes(params.get("state")!)) return null;
  if (values.limit !== undefined && (values.limit < 1 || values.limit > 200)) return null;
  return { ...values, agentId, state: params.get("state") !== "false" };
}

export const VIEW = withAuth<ViewRequest>(async (req, caller) => {
  const { id: workspaceId, sessionId } = req.params;
  const query = parseViewQuery(new URL(req.url).searchParams);
  if (!query) return errorResponse("invalid_cursor", 400);
  const denied = await authorize(workspaceId, caller.userId);
  if (denied) return denied;
  const { data, error } = await serviceClient.rpc("read_session_view", {
    p_workspace_id: workspaceId, p_session_id: sessionId, p_agent_id: query.agentId,
    p_before: query.before ?? null, p_after: query.after ?? null, p_around: query.around ?? null,
    p_through: query.through ?? null, p_limit: query.limit ?? 200, p_state: query.state,
  });
  if (error) {
    if (error.message.includes("event_not_found")) return errorResponse("event_not_found", 404);
    return knownDbError(error.message) ?? errorResponse("session_view_failed", 500, error, workspaceId, sessionId);
  }
  const result = data as { page: SessionTranscriptPage; snapshot?: { session: SessionRow; approvals: LiveSessionEvent[]; agents: SessionAgentSummary[] } };
  const rows = [...result.page.events, ...result.page.dependencies];
  const [authors, inputs, recent, links] = await Promise.all([
    loadTurnAuthors(workspaceId, sessionId, rows),
    query.state ? loadViewerInputs(workspaceId, sessionId, caller.userId) : null,
    query.state ? loadRecentAuthors(workspaceId, sessionId) : null,
    result.snapshot ? loadSessionLinks(workspaceId, result.snapshot.session) : null,
  ]);
  if (!authors.ok || (inputs && !inputs.ok) || (recent && !recent.ok)) return errorResponse("session_view_failed", 500, undefined, workspaceId, sessionId);
  if (links instanceof Response) return links;
  const ids = [...new Set([caller.userId, ...authors.bySeq.values(), ...(result.snapshot ? [result.snapshot.session.owner_user_id] : []), ...(inputs?.inputs.map((i) => i.author_user_id) ?? []), ...(recent?.rows.map((r) => r.author_user_id) ?? [])])];
  const names = await loadDisplayNames(serviceClient, ids, []);
  if (!names.ok) return errorResponse(names.code, 500, names.detail, workspaceId, sessionId);
  const named = (events: LiveSessionEvent[]) => events.map((event) => {
    const id = authors.bySeq.get(event.seq);
    return id ? { ...event, author_user_id: id, author_name: names.users.get(id) ?? null } : event;
  });
  const page = { ...result.page, events: named(result.page.events), dependencies: named(result.page.dependencies) };
  if (!result.snapshot) return Response.json({ page });
  const session = Object.fromEntries(SESSION_COLUMNS.split(", ").map((key) => [key, result.snapshot!.session[key as keyof SessionRow]]));
  return Response.json({ page, snapshot: {
    session: { ...session, mine: caller.userId === result.snapshot.session.owner_user_id, owner_name: names.users.get(result.snapshot.session.owner_user_id) ?? null, ...links },
    viewer: { id: caller.userId, name: names.users.get(caller.userId) ?? "A teammate" },
    inputs: inputs!.inputs.map((i) => ({ ...i, author_name: names.users.get(i.author_user_id) ?? i.author_name })),
    approvals: result.snapshot.approvals, agents: result.snapshot.agents,
    authors: recent!.rows.map((r) => ({ seq: r.consumed_seq, author_user_id: r.author_user_id, author_name: names.users.get(r.author_user_id) ?? null })),
  } });
});
