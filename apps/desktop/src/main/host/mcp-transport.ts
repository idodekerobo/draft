export interface SessionMcpBinding { sessionId: string; workspaceId: string; hostId: string }
export class McpTransportError extends Error {
  constructor(readonly reason: "sign_in_required" | "upstream_unavailable") { super(reason); }
}
const FORWARDED_HEADERS = ["accept", "content-type", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
export const MCP_MAX_BODY_BYTES = 4 * 1024 * 1024;

export async function bufferMcpBody(request: Request): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return new Uint8Array(Buffer.concat(chunks));
      bytes += next.value.byteLength;
      if (bytes > MCP_MAX_BODY_BYTES) throw new Error("mcp_body_too_large");
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
}

export function createSessionMcpTransport(deps: {
  apiUrl: string;
  token(forceRefresh: boolean): Promise<string>;
  fetch(input: string, init: RequestInit): Promise<Response>;
}) {
  const endpoint = new URL("/mcp", deps.apiUrl).toString();
  return async (binding: SessionMcpBinding, request: Request): Promise<Response> => {
    const body = await bufferMcpBody(request);
    const send = async (forceRefresh: boolean) => {
      let token: string;
      try { token = await deps.token(forceRefresh); }
      catch (error) {
        const terminal = error instanceof Error && (error.message === "not_signed_in" || (error as Error & { kind?: string }).kind === "terminal");
        throw new McpTransportError(terminal ? "sign_in_required" : "upstream_unavailable");
      }
      const headers = new Headers();
      for (const name of FORWARDED_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      headers.set("authorization", `Bearer ${token}`);
      headers.set("x-draft-session-id", binding.sessionId);
      headers.set("x-draft-workspace-id", binding.workspaceId);
      headers.set("x-draft-host-id", binding.hostId);
      return deps.fetch(endpoint, { method: request.method, headers, body: body?.slice(), redirect: "manual", signal: request.signal });
    };
    const first = await send(false);
    if (first.status !== 401) return first;
    void first.body?.cancel().catch(() => {});
    return send(true);
  };
}
