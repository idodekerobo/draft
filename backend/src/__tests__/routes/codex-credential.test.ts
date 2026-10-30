import { beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { randomBytes } from "node:crypto";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let db: FakeDb = fakeDb();

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) => (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => accessResult }));
mock.module("../../db/client", () => ({
  serviceClient: {
    from: (table: string) => fakeClient(db).from(table),
    rpc: (name: string, args: Record<string, unknown>) => fakeClient(db).rpc(name, args),
  },
}));

const routes = await import("../../routes/codex-credential");

const chatgpt = JSON.stringify({ auth_mode: "chatgpt", last_refresh: "t", tokens: { refresh_token: "r1" } });

function call(method: "GET" | "PUT", body?: unknown) {
  const req = new Request("http://localhost/workspaces/ws-1/codex-credential", { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return Object.assign(req, { params: { id: "ws-1" } }) as never;
}

beforeAll(() => {
  process.env.INFERENCE_CREDENTIAL_KEK_V2 = randomBytes(32).toString("base64");
});

beforeEach(() => {
  accessResult = null;
  db = fakeDb();
});

describe("codex credential routes", () => {
  it("reports no login, then an active one after it is saved by any member", async () => {
    expect(await (await routes.GET(call("GET"))).json()).toEqual({ ok: true, status: null });

    const saved = await routes.PUT(call("PUT", { auth_json: chatgpt }));
    expect(saved.status).toBe(200);
    expect(db.tables.credentials![0]).toMatchObject({ workspace_id: "ws-1", provider: "codex_chatgpt_auth", status: "active", created_by_user_id: "user-1" });
    expect(JSON.stringify(db.tables.credentials)).not.toContain("r1");

    expect(await (await routes.GET(call("GET"))).json()).toEqual({ ok: true, status: "active" });
  });

  it("never sends the login back", async () => {
    await routes.PUT(call("PUT", { auth_json: chatgpt }));
    expect(await (await routes.GET(call("GET"))).text()).not.toContain("r1");
  });

  it("refuses a file that cannot run a routine, and saves nothing", async () => {
    const response = await routes.PUT(call("PUT", { auth_json: JSON.stringify({ auth_mode: "chatgpt", tokens: {} }) }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid_auth_json" });
    expect(db.tables.credentials ?? []).toHaveLength(0);
  });

  it("refuses a caller who is not in the workspace", async () => {
    accessResult = new Response(null, { status: 403 });
    expect((await routes.PUT(call("PUT", { auth_json: chatgpt }))).status).toBe(403);
    expect((await routes.GET(call("GET"))).status).toBe(403);
    expect(db.tables.credentials ?? []).toHaveLength(0);
  });
});
