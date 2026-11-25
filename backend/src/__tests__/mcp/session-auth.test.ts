import { expect, test } from "bun:test";
import { createSessionMcpHandler, hasSessionContext } from "../../mcp/session-auth";
const context = { sessionId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222", hostId: "host" };
const headers = { "x-draft-session-id": context.sessionId, "x-draft-workspace-id": context.workspaceId, "x-draft-host-id": context.hostId, "x-draft-client": "desktop" };

test("partial session context refuses before authentication and never becomes OAuth", async () => {
  const request = new Request("https://api.test/mcp", { headers: { "x-draft-session-id": context.sessionId } });
  expect(hasSessionContext(request)).toBe(true);
  const handler = createSessionMcpHandler({ verify: async () => { throw new Error("must not verify"); }, authorize: async () => null, handle: async () => new Response() });
  expect((await handler(request)).status).toBe(400);
});

test("invalid Supabase login has no browser OAuth challenge", async () => {
  const handler = createSessionMcpHandler({ verify: async () => null, authorize: async () => null, handle: async () => new Response() });
  const response = await handler(new Request("https://api.test/mcp", { headers }));
  expect(response.status).toBe(401);
  expect(response.headers.has("www-authenticate")).toBe(false);
});

test("session denial preserves 403 and prevents tool invocation", async () => {
  const handler = createSessionMcpHandler({ verify: async () => ({ userId: "owner" }), authorize: async () => Response.json({ error: "session_ended" }, { status: 403 }), handle: async () => { throw new Error("must not call tools"); } });
  expect((await handler(new Request("https://api.test/mcp", { headers }))).status).toBe(403);
});

test("verified session context and owner reach the gateway despite desktop headers", async () => {
  const handler = createSessionMcpHandler({ verify: async () => ({ userId: "owner" }), authorize: async (binding, userId) => {
    expect(binding).toEqual(context); expect(userId).toBe("owner"); return null;
  }, handle: async (_request, binding, userId) => Response.json({ binding, userId }) });
  expect(await (await handler(new Request("https://api.test/mcp", { headers }))).json()).toEqual({ binding: context, userId: "owner" });
});

test("target checks reject cloud, foreign hosts and ended sessions independently", async () => {
  const { sessionTargetDenial } = await import("../../mcp/session-auth");
  const live = { execution_target: "host", host_id: "host", status: "live" };
  expect(sessionTargetDenial(live, "host")).toBeNull();
  for (const changed of [{ execution_target: "sandbox" }, { host_id: "another" }, { status: "ended" }]) {
    const denied = sessionTargetDenial({ ...live, ...changed }, "host");
    expect(denied?.status).toBe(403); expect(denied?.headers.has("www-authenticate")).toBe(false);
  }
});
