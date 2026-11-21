import { describe, expect, it } from "bun:test";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { personCaller } from "draft-core/tools";
import { createIntegrationTools } from "../../../metaharness/tools/definitions/integrations";
import { invokeTool, type ToolCallRecord } from "../../../metaharness/tools/invoke-tool";
import { ToolRegistry } from "../../../metaharness/tools/tool-registry";
import { fakeClient, fakeDb, type FakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

const connection = (provider: string, status = "active", by: string | null = ME) => ({ workspace_id: WS, provider, status, connected_by_user_id: by });

function setup(rows: Array<ReturnType<typeof connection>>, outcome: "disconnected" | "not_found" | "not_owner" = "disconnected") {
  const db: FakeDb = fakeDb({ connections: rows }, {
    rpcs: { disconnect_connection: () => ({ data: [{ connection_id: "conn-1", outcome }] }) },
  });
  const audits: ToolCallRecord[] = [];
  const registry = new ToolRegistry(createIntegrationTools(fakeClient(db)));
  const deps = { registry, audit: async (record: ToolCallRecord) => { audits.push(record); }, authorizeUser: async () => null };
  const caller = personCaller({ userId: parseUserId(ME), workspaceId: parseWorkspaceId(WS), via: "mcp" });
  return { db, audits, call: (args: unknown) => invokeTool(deps, caller, "connections.disconnect", args) };
}

describe("connections.disconnect", () => {
  it("reports what would stop and changes nothing until it is confirmed", async () => {
    const { db, call } = setup([connection("linear")]);
    const result = await call({ provider: "linear" });
    expect(result).toMatchObject({ status: "ok", output: { status: "confirmation_required", provider: "linear", connectedByYou: true } });
    const output = (result as { output: { stops: { triggers: string[] }; message: string } }).output;
    expect(output.stops.triggers.length).toBeGreaterThan(0);
    expect(output.message).toContain('"confirm":true');
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("disconnects with confirm and passes the caller as the owner", async () => {
    const { db, call } = setup([connection("linear")]);
    const result = await call({ provider: "linear", confirm: true });
    expect(result).toMatchObject({ status: "ok", output: { status: "disconnected", provider: "linear" } });
    expect(db.rpcCalls).toEqual([{ name: "disconnect_connection", args: { p_workspace_id: WS, p_provider: "linear", p_connected_by_user_id: ME, p_account_kind: null } }]);
  });

  it("sends Granola's account kind, defaulting to personal", async () => {
    const personal = setup([connection("granola")]);
    await personal.call({ provider: "granola", confirm: true });
    expect(personal.db.rpcCalls[0]?.args.p_account_kind).toBe("personal");
    const workspace = setup([connection("granola", "active", null)]);
    await workspace.call({ provider: "granola", accountKind: "workspace", confirm: true });
    expect(workspace.db.rpcCalls[0]?.args.p_account_kind).toBe("workspace");
  });

  it("refuses an account kind for any provider but Granola", async () => {
    const { db, call } = setup([connection("slack")]);
    expect(await call({ provider: "slack", accountKind: "workspace", confirm: true })).toMatchObject({ status: "refused", code: "invalid_account_kind" });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("refuses Claude Code sessions", async () => {
    const { call } = setup([connection("claude_session")]);
    expect(await call({ provider: "claude_session", confirm: true })).toMatchObject({ status: "refused", code: "not_supported" });
  });

  it("says so when the provider is not connected, without calling the database", async () => {
    const { db, call } = setup([]);
    expect(await call({ provider: "linear", confirm: true })).toMatchObject({ status: "ok", output: { status: "not_connected", provider: "linear" } });
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("refuses when someone else connected it", async () => {
    const { call } = setup([connection("slack", "active", OTHER)], "not_owner");
    expect(await call({ provider: "slack", confirm: true })).toMatchObject({ status: "refused", code: "not_connection_owner" });
  });

  it("rejects a confirm that is not true", async () => {
    const { call } = setup([connection("linear")]);
    expect(await call({ provider: "linear", confirm: "yes" })).toMatchObject({ status: "invalid" });
  });

  it("audits the provider and whether the call was confirmed", async () => {
    const { audits, call } = setup([connection("linear")]);
    await call({ provider: "linear" });
    await call({ provider: "linear", confirm: true });
    expect(audits.map((record) => record.arguments)).toEqual([
      { provider: "linear", accountKind: null, confirm: false },
      { provider: "linear", accountKind: null, confirm: true },
    ]);
  });
});
