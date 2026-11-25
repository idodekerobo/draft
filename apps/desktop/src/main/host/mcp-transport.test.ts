import { expect, test } from "bun:test";
import { createSessionMcpTransport, McpTransportError } from "./mcp-transport";
const binding = { sessionId: "session", workspaceId: "workspace", hostId: "host" };

test("buffers the body for one auth retry and replaces all caller identity headers", async () => {
  const attempts: boolean[] = [];
  let calls = 0;
  const transport = createSessionMcpTransport({ apiUrl: "https://api.test", token: async (force) => { attempts.push(force); return force ? "new" : "old"; }, fetch: (async (url, options) => {
    expect(url).toBe("https://api.test/mcp");
    const request = new Request(url as string, options);
    expect(await request.text()).toBe('{"jsonrpc":"2.0","id":1}');
    expect(request.headers.get("x-draft-session-id")).toBe("session");
    expect(request.headers.has("x-draft-client")).toBe(false);
    expect(options?.redirect).toBe("manual");
    return ++calls === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true });
  }) });
  const result = await transport(binding, new Request("http://localhost/mcp", { method: "POST", headers: { authorization: "Bearer caller", "x-draft-client": "desktop", "x-draft-session-id": "spoof" }, body: '{"jsonrpc":"2.0","id":1}' }));
  expect(result.status).toBe(200); expect(attempts).toEqual([false, true]); expect(calls).toBe(2);
});

test("permanent refresh failure is a tool auth error without app sign-out", async () => {
  const transport = createSessionMcpTransport({ apiUrl: "https://api.test", token: async () => { throw Object.assign(new Error("refresh_failed"), { kind: "terminal" }); }, fetch: (() => { throw new Error("must not fetch"); }) });
  try { await transport(binding, new Request("http://localhost/mcp")); throw new Error("must reject"); }
  catch (error) { expect(error).toBeInstanceOf(McpTransportError); expect((error as McpTransportError).reason).toBe("sign_in_required"); }
});

test("does not replay session refusals or ambiguous network failures", async () => {
  for (const outcome of [403, 500, "network"] as const) {
    let calls = 0;
    const transport = createSessionMcpTransport({ apiUrl: "https://api.test", token: async () => "token", fetch: (async () => {
      calls++; if (outcome === "network") throw new Error("network"); return new Response(null, { status: outcome });
    }) });
    await transport(binding, new Request("http://localhost/mcp")).catch(() => {});
    expect(calls).toBe(1);
  }
});
