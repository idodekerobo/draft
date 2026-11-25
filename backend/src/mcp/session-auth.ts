export const SESSION_HEADERS = ["x-draft-session-id", "x-draft-workspace-id", "x-draft-host-id"] as const;
export interface SessionMcpContext { sessionId: string; workspaceId: string; hostId: string }
export interface SessionMcpAuthDeps {
  verify(request: Request): Promise<{ userId: string } | null>;
  authorize(context: SessionMcpContext, userId: string): Promise<Response | null>;
  handle(request: Request, context: SessionMcpContext, userId: string): Promise<Response>;
}
export const hasSessionContext = (request: Request) => SESSION_HEADERS.some((name) => request.headers.has(name));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createSessionMcpHandler(deps: SessionMcpAuthDeps) {
  return async (request: Request): Promise<Response> => {
    const [sessionId, workspaceId, hostId] = SESSION_HEADERS.map((name) => request.headers.get(name)?.trim());
    if (!sessionId || !workspaceId || !hostId || !uuid.test(sessionId) || !uuid.test(workspaceId) || hostId.length > 200) {
      return Response.json({ error: "invalid_session_context" }, { status: 400 });
    }
    const caller = await deps.verify(request);
    if (!caller) return Response.json({ error: "invalid_login" }, { status: 401 });
    const context = { sessionId, workspaceId, hostId };
    const denied = await deps.authorize(context, caller.userId);
    return denied ?? deps.handle(request, context, caller.userId);
  };
}

export function sessionTargetDenial(session: { execution_target?: string; host_id: string | null; status: string }, hostId: string): Response | null {
  if (session.execution_target !== "host") return Response.json({ error: "session_not_local" }, { status: 403 });
  if (session.host_id !== hostId) return Response.json({ error: "foreign_host" }, { status: 403 });
  if (session.status === "ended") return Response.json({ error: "session_ended" }, { status: 403 });
  return null;
}
