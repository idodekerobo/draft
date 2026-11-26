import { beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let db: FakeDb = fakeDb();

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) => (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => accessResult }));
mock.module("../../db/client", () => ({ serviceClient: { from: (table: string) => fakeClient(db).from(table) } }));

const routes = await import("../../routes/workspace-model-provider");

function call(method: "GET" | "PUT", body?: unknown) {
  const req = new Request("http://localhost/workspaces/ws-1/model-provider", { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return Object.assign(req, { params: { id: "ws-1" } }) as never;
}

const seed = (role: "owner" | "admin" | "member") => {
  db = fakeDb({ workspaces: [{ id: "ws-1", default_model_provider: "anthropic" }], users: [{ id: "user-1", organization_role: role }] });
};

beforeEach(() => {
  accessResult = null;
  seed("member");
});

describe("workspace model provider routes", () => {
  it("shows every member the lab, and says only admins can change it", async () => {
    const member = await (await routes.GET(call("GET"))).json();
    expect(member).toMatchObject({ ok: true, provider: "anthropic", can_edit: false });
    seed("admin");
    expect(await (await routes.GET(call("GET"))).json()).toMatchObject({ can_edit: true });
  });

  it("lets an owner or admin pick a lab", async () => {
    for (const role of ["owner", "admin"] as const) {
      seed(role);
      const response = await routes.PUT(call("PUT", { provider: "anthropic" }));
      expect(response.status).toBe(200);
      expect(db.tables.workspaces![0]!.default_model_provider).toBe("anthropic");
    }
  });

  it("refuses a member, and changes nothing", async () => {
    db.tables.workspaces![0]!.default_model_provider = "before";
    const response = await routes.PUT(call("PUT", { provider: "anthropic" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "not_admin" });
    expect(db.tables.workspaces![0]!.default_model_provider).toBe("before");
  });

  it("refuses a lab that is not available yet or does not exist", async () => {
    seed("owner");
    for (const provider of ["openai", "nope", 3, null]) {
      const response = await routes.PUT(call("PUT", { provider }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, error: "invalid_provider" });
    }
  });

  it("refuses a caller who is not in the workspace", async () => {
    accessResult = new Response(null, { status: 403 });
    expect((await routes.GET(call("GET"))).status).toBe(403);
    expect((await routes.PUT(call("PUT", { provider: "anthropic" }))).status).toBe(403);
  });
});
