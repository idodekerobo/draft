import { beforeEach, describe, expect, it, mock } from "bun:test";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { personCaller } from "draft-core/tools";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const MATE = "44444444-4444-4444-8444-444444444444";

let caller = { userId: MATE, accessToken: "t" };
let db: FakeDb = fakeDb();

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) => (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({ assertWorkspaceAccess: async () => null }));
mock.module("../../db/client", () => ({
  serviceClient: { from: (table: string) => fakeClient(db).from(table), rpc: (name: string, args: Record<string, unknown>) => fakeClient(db).rpc(name, args) },
}));

// A route handler is wrapped by withAuth when its module loads. In a full run another test file may have loaded it first,
// so import fresh copies that take this file's mocks.
const fresh = <T,>(path: string): Promise<T> => import(`${path}?home-access`) as Promise<T>;
const inputs = await fresh<typeof import("../../routes/sessions-live-inputs")>("../../routes/sessions-live-inputs");
const approvals = await fresh<typeof import("../../routes/sessions-live-approvals")>("../../routes/sessions-live-approvals");
const title = await fresh<typeof import("../../routes/sessions-live-title")>("../../routes/sessions-live-title");
const live = await fresh<typeof import("../../routes/sessions-live")>("../../routes/sessions-live");
const sessionsTools = await import("../../metaharness/tools/definitions/sessions");

function request(method: "GET" | "POST", params: Record<string, string>, body?: unknown) {
  return Object.assign(new Request("http://localhost/x", { method, body: body === undefined ? undefined : JSON.stringify(body) }), { params: { id: WS, sessionId: HOME, ...params } }) as never;
}

beforeEach(() => {
  caller = { userId: MATE, accessToken: "t" };
  db = fakeDb({
    sessions: [{ id: HOME, workspace_id: WS, owner_user_id: OWNER, is_home: true, session_type: "interactive", title: "Private", status: "live", harness: "claude", deleted_at: null }],
    session_inputs: [],
    users: [{ id: OWNER, display_name: "Owner" }, { id: MATE, display_name: "Mate" }],
  });
});

const routes: Array<[string, () => Promise<Response>]> = [
  ["list inputs", () => inputs.INPUTS_LIST(request("GET", {}))],
  ["send a message", () => inputs.INPUTS_CREATE(request("POST", {}, { text: "hello" }))],
  ["act on an input", () => inputs.INPUT_ACTION(request("POST", { inputId: "55555555-5555-4555-8555-555555555555" }, { action: "dismiss" }))],
  ["decide an approval", () => approvals.DECISION(request("POST", { requestId: "req-1" }, { decision: "allow" }))],
  ["stop", () => approvals.STOP(request("POST", {}, {}))],
  ["change the mode", () => approvals.MODE(request("POST", {}, { permissionMode: "auto" }))],
];

describe("another person's Home session", () => {
  for (const [name, call] of routes) {
    it(`is not found when a teammate tries to ${name}, and nothing is written`, async () => {
      const response = await call();
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: "session_not_found" });
      expect(db.rpcCalls.filter((rpc) => rpc.name !== "save_harness_credential")).toEqual([]);
      expect(db.tables.session_inputs).toEqual([]);
    });
  }

  it("is in nobody's session list, not even its owner's", async () => {
    db.tables.sessions!.push({ id: "66666666-6666-4666-8666-666666666666", workspace_id: WS, owner_user_id: OWNER, is_home: false, session_type: "interactive", title: "Real", status: "live", harness: "claude", deleted_at: null, started_at: "2026-11-26T00:00:00Z" });
    for (const userId of [OWNER, MATE]) {
      caller = { userId, accessToken: "t" };
      const body = (await (await live.LIST(request("GET", {}))).json()) as { sessions: Array<{ id: string }> };
      expect(body.sessions.map((row) => row.id)).toEqual(["66666666-6666-4666-8666-666666666666"]);
    }
  });

  it("is not shared by link, so the public title route says nothing about it", async () => {
    const response = await title.TITLE(Object.assign(new Request("http://localhost/x"), { params: { sessionId: HOME } }) as never);
    expect(await response.json()).toEqual({ title: null });
  });

  it("is left out of the list tool and refused by the read tool for a teammate, and open to its owner", async () => {
    const tools = sessionsTools.createSessionTools(fakeClient(db));
    const run = (name: string, userId: string, input: unknown) =>
      tools.find((candidate) => candidate.name === name)!.run(personCaller({ userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "mcp" }), input as never);

    const mateList = (await run("sessions.list", MATE, {})) as unknown as { output: { sessions: unknown[] } };
    expect(mateList.output.sessions).toEqual([]);
    expect(await run("sessions.read", MATE, { session_id: HOME })).toMatchObject({ status: "refused", code: "session_not_found" });

    const ownerList = (await run("sessions.list", OWNER, {})) as unknown as { output: { sessions: Array<{ id: string }> } };
    expect(ownerList.output.sessions.map((row) => row.id)).toEqual([HOME]);
    const ownerRead = (await run("sessions.read", OWNER, { session_id: HOME })) as unknown as { status: string; output: { session: Record<string, unknown> } };
    expect(ownerRead.status).toBe("ok");
    expect(ownerRead.output.session).not.toHaveProperty("is_home");
  });
});

describe("a Home session for its owner", () => {
  it("lists the owner's own inputs", async () => {
    caller = { userId: OWNER, accessToken: "t" };
    const response = await inputs.INPUTS_LIST(request("GET", {}));
    expect(response.status).toBe(200);
  });
});

describe("changing Home's model", () => {
  it("lets the owner pick one of pi's models, saves it as an input, and refuses other models and other settings", async () => {
    caller = { userId: OWNER, accessToken: "t" };
    db.tables.sessions![0]!.execution_target = "backend";
    const mode = (body: object) => approvals.MODE(request("POST", {}, body));
    expect((await mode({ model: "claude-sonnet-5-5" })).status).toBe(201);
    expect(db.rpcCalls.at(-1)).toMatchObject({ name: "create_session_input", args: { p_kind: "set_mode", p_payload: { model: "claude-sonnet-5-5" } } });
    expect((await mode({ model: "not-a-model" })).status).toBe(400);
    expect((await mode({ permissionMode: "auto" })).status).toBe(400);
    expect((await mode({ model: "claude-sonnet-5-5", reasoningEffort: "high" })).status).toBe(400);
  });

  it("is not changed by a teammate", async () => {
    db.tables.sessions![0]!.execution_target = "backend";
    expect((await approvals.MODE(request("POST", {}, { model: "claude-sonnet-5-5" }))).status).toBe(404);
  });
});
