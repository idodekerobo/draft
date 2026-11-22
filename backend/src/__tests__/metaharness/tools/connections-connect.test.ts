import { describe, expect, it } from "bun:test";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { personCaller } from "draft-core/tools";
import { createIntegrationTools } from "../../../metaharness/tools/definitions/integrations";
import { invokeTool } from "../../../metaharness/tools/invoke-tool";
import { ToolRegistry } from "../../../metaharness/tools/tool-registry";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";

const connection = (provider: string, status = "active") => ({ workspace_id: WS, provider, status, connected_by_user_id: ME });

function setup(rows: Array<ReturnType<typeof connection>>) {
  const db = fakeDb({ connections: rows });
  const registry = new ToolRegistry(createIntegrationTools(fakeClient(db)));
  const caller = personCaller({ userId: parseUserId(ME), workspaceId: parseWorkspaceId(WS), via: "mcp" });
  const call = (args: unknown) => invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, caller, "connections.connect", args);
  return { db, call };
}

describe("connections.connect", () => {
  it("answers a connected provider with a message and no link", async () => {
    const { db, call } = setup([connection("slack")]);
    const result = await call({ provider: "slack" });
    expect(result).toMatchObject({ status: "ok", output: { status: "connected", provider: "slack", message: "Slack is already connected. No link is needed." } });
    expect(db.tables.connection_requests ?? []).toHaveLength(0);
  });

  it("answers a saved connection that is waiting for its first event as pending", async () => {
    const { call } = setup([connection("fireflies", "pending")]);
    expect(await call({ provider: "fireflies" })).toMatchObject({ status: "ok", output: { status: "pending", provider: "fireflies" } });
  });

  it("gives a link to a provider that is not connected", async () => {
    const { db, call } = setup([]);
    const result = await call({ provider: "linear" });
    expect(result).toMatchObject({ status: "ok", output: { status: "action_required", provider: "linear" } });
    expect(db.tables.connection_requests ?? []).toHaveLength(1);
  });
});
