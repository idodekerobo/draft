import { describe, expect, it } from "bun:test";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { personCaller } from "draft-core/tools";
import { createIntegrationTools, type IntegrationToolDeps } from "../../../metaharness/tools/definitions/integrations";
import { invokeTool } from "../../../metaharness/tools/invoke-tool";
import { ToolRegistry } from "../../../metaharness/tools/tool-registry";
import type { SlackMembershipResult } from "../../../integrations/slack-channels";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";

const connection = (provider: string, status = "active") => ({ workspace_id: WS, provider, status, connected_by_user_id: ME });
const membership = (overrides: Partial<Extract<SlackMembershipResult, { ok: true }>> = {}): SlackMembershipResult => ({
  ok: true, channelIds: ["C1", "C2"], joined: ["C2"], left: [], failed: [], ...overrides,
});

function setup(rows: Array<ReturnType<typeof connection>>, channels: Partial<NonNullable<IntegrationToolDeps["slackChannels"]>> = {}) {
  const resolved: unknown[][] = [];
  const set: unknown[][] = [];
  const db = fakeDb({ connections: rows });
  const registry = new ToolRegistry(createIntegrationTools(fakeClient(db), {
    slackChannels: {
      resolve: channels.resolve ?? (async (_client, _workspace, entries) => { resolved.push(entries); return { ok: true, channelIds: entries.map((_, index) => `C${index + 1}`) }; }),
      set: channels.set ?? (async (_client, _workspace, ids) => { set.push(ids); return membership({ channelIds: ids }); }),
    },
  }));
  const caller = personCaller({ userId: parseUserId(ME), workspaceId: parseWorkspaceId(WS), via: "mcp" });
  const call = (args: unknown) => invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, caller, "connections.connect", args);
  return { db, resolved, set, call };
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

  it("sets Slack's channels when it is connected, resolving names first", async () => {
    const { resolved, set, call } = setup([connection("slack")]);
    const result = await call({ provider: "slack", channels: ["#general", "C2"] });
    expect(resolved).toEqual([["#general", "C2"]]);
    expect(set).toEqual([["C1", "C2"]]);
    expect(result).toMatchObject({
      status: "ok",
      output: { status: "connected", provider: "slack", channels: { ids: ["C1", "C2"], joined: ["C2"], left: [], failed: [] } },
    });
    expect((result as { output: { message: string } }).output.message).toBe("Slack is already connected. Channels updated: 1 joined, 0 left.");
  });

  it("says when a channel could not be joined", async () => {
    const { call } = setup([connection("slack")], {
      set: async () => membership({ joined: [], failed: [{ channelId: "C2", operation: "join", code: "slack_channel_join_failed" }] }),
    });
    const result = await call({ provider: "slack", channels: ["C2"] });
    expect((result as { output: { message: string } }).output.message).toContain("1 could not be joined");
  });

  it("refuses channels for a provider that has none", async () => {
    const { set, call } = setup([connection("linear")]);
    expect(await call({ provider: "linear", channels: ["#general"] })).toMatchObject({ status: "refused", code: "channels_not_supported" });
    expect(set).toHaveLength(0);
  });

  it("refuses channels when Slack is not connected yet, and says how to connect it", async () => {
    const { set, call } = setup([]);
    const result = await call({ provider: "slack", channels: ["#general"] });
    expect(result).toMatchObject({ status: "refused", code: "not_connected" });
    expect((result as { message: string }).message).toContain("connections.connect");
    expect(set).toHaveLength(0);
  });

  it("passes on a channel name that matches nothing, with the reason", async () => {
    const { set, call } = setup([connection("slack")], {
      resolve: async () => ({ ok: false, code: "channel_not_found", message: 'No public Slack channel matches "#nope". Public channels include: #general.' }),
    });
    const result = await call({ provider: "slack", channels: ["#nope"] });
    expect(result).toMatchObject({ status: "refused", code: "channel_not_found" });
    expect((result as { message: string }).message).toContain("#general");
    expect(set).toHaveLength(0);
  });

  it("asks to try again when the connection changed at the same time", async () => {
    const { call } = setup([connection("slack")], { set: async () => ({ ok: false, code: "connection_update_conflict", status: 409 }) });
    const result = await call({ provider: "slack", channels: ["C1"] });
    expect(result).toMatchObject({ status: "refused", code: "connection_update_conflict" });
    expect((result as { message: string }).message).toContain("Try again");
  });
});
