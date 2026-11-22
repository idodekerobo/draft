import { describe, expect, it, mock } from "bun:test";
import { parseAgentRunId, parseContextVersionId, parseScheduledTaskId, parseIsoTimestamp, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { personCaller, runCaller, type AnyDraftToolPermission } from "draft-core/tools";
import { createIntegrationTools, type IntegrationToolDeps } from "../../../metaharness/tools/definitions/integrations";
import { invokeTool } from "../../../metaharness/tools/invoke-tool";
import { ToolRegistry } from "../../../metaharness/tools/tool-registry";
import type { SlackMembershipResult } from "../../../integrations/slack-channels";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const TASK = "66666666-6666-4666-8666-666666666666";

const runSpec = (permissions: AnyDraftToolPermission[]): AgentRunSpec => ({
  id: parseAgentRunId(RUN), kind: "routine", network: "open",
  workspaceId: parseWorkspaceId(WS),
  trigger: { type: "cron", scheduledTaskId: parseScheduledTaskId(TASK), occurrenceAt: parseIsoTimestamp("2026-11-11T09:00:00.000Z") },
  onBehalfOf: parseUserId(OWNER),
  runtime: { type: "cloud", toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] } },
  harness: "claude", model: null, instructions: "", inputs: { contextVersionId: parseContextVersionId("77777777-7777-4777-8777-777777777777") },
  permissions, output: { type: "text" },
});

const person = () => personCaller({ userId: parseUserId(OWNER), workspaceId: parseWorkspaceId(WS), via: "cli" });

/** Largest first: general 100, random 80, eng 60, ops 40, ml 10. The bot is in general and ops. */
const SLACK_CHANNELS = [
  { id: "C-ml", name: "ml", is_member: false, num_members: 10 },
  { id: "C-general", name: "general", is_member: true, num_members: 100 },
  { id: "C-ops", name: "ops", is_member: true, num_members: 40 },
  { id: "C-random", name: "random", is_member: false, num_members: 80 },
  { id: "C-eng", name: "eng", is_member: false, num_members: 60 },
];
const slackFetch = () => mock(async () => Response.json({ ok: true, channels: SLACK_CHANNELS, response_metadata: { next_cursor: "" } })) as unknown as typeof fetch;

const connectedSlack = [{ workspace_id: WS, provider: "slack", status: "active", connected_by_user_id: OWNER }];

function setup(options: { connected?: boolean; slack?: IntegrationToolDeps["slack"]; channels?: Partial<NonNullable<IntegrationToolDeps["slackChannels"]>> } = {}) {
  const db = fakeDb({ connections: options.connected === false ? [] : connectedSlack });
  const registry = new ToolRegistry(createIntegrationTools(fakeClient(db), {
    slack: { fetch: slackFetch(), credentialId: async () => (options.connected === false ? null : "cred"), botToken: async () => "xoxb-test", ...options.slack },
    slackChannels: {
      resolve: options.channels?.resolve ?? (async (_client, _workspace, entries) => {
        const ids: Record<string, string> = { "#general": "C-general", "#eng": "C-eng", "#ops": "C-ops", "C-eng": "C-eng" };
        const found = entries.map((entry) => ids[entry]);
        const missing = entries.find((_, index) => !found[index]);
        if (missing) return { ok: false, code: "channel_not_found", message: `No public Slack channel matches "${missing}". Public channels include: #general, #eng, #ops.` };
        return { ok: true, channelIds: found as string[], channels: (found as string[]).map((id) => ({ id, name: id.replace("C-", "") })) };
      }),
      update: options.channels?.update ?? (async () => { throw new Error("not expected"); }),
    },
  }));
  const invoke = (caller: ReturnType<typeof person>, tool: string, args: unknown) =>
    invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, caller, tool, args);
  return { invoke };
}

/** Applies the change to a channel set the way the connection would, so the tests see what join and leave leave behind. */
type FailedChange = Extract<SlackMembershipResult, { ok: true }>["failed"];
const applyTo = (current: string[], failed: FailedChange = []): NonNullable<IntegrationToolDeps["slackChannels"]>["update"] =>
  async (_client, _workspace, next) => {
    const desired = next(current);
    const failedIds = failed.map((entry) => entry.channelId);
    const settled = desired.filter((id) => !failedIds.includes(id));
    return {
      ok: true,
      channelIds: settled,
      joined: settled.filter((id) => !current.includes(id)),
      left: current.filter((id) => !desired.includes(id)),
      failed,
    };
  };

describe("connections.list with available", () => {
  it("lists every public channel, biggest first, with whether the bot is in it, next to the channels it has joined", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.list", { provider: "slack", available: true });
    const slack = (result as { output: { connections: Array<Record<string, any>> } }).output.connections[0]!;
    expect(slack.channels).toEqual([{ id: "C-general", name: "general" }, { id: "C-ops", name: "ops" }]);
    expect(slack.available.channels).toEqual([
      { id: "C-general", name: "general", memberCount: 100, joined: true },
      { id: "C-random", name: "random", memberCount: 80, joined: false },
      { id: "C-eng", name: "eng", memberCount: 60, joined: false },
      { id: "C-ops", name: "ops", memberCount: 40, joined: true },
      { id: "C-ml", name: "ml", memberCount: 10, joined: false },
    ]);
    expect(slack.available.nextCursor).toBeNull();
  });

  it("pages with limit and cursor until the last page has no next cursor", async () => {
    const { invoke } = setup();
    const page = async (cursor?: string) => {
      const result = await invoke(person(), "connections.list", { provider: "slack", available: true, limit: 2, ...(cursor ? { cursor } : {}) });
      return (result as { output: { connections: Array<{ available: { channels: Array<{ name: string }>; nextCursor: string | null } }> } }).output.connections[0]!.available;
    };
    const first = await page();
    expect(first.channels.map((channel) => channel.name)).toEqual(["general", "random"]);
    expect(first.nextCursor).toBeString();
    const second = await page(first.nextCursor!);
    expect(second.channels.map((channel) => channel.name)).toEqual(["eng", "ops"]);
    const third = await page(second.nextCursor!);
    expect(third.channels.map((channel) => channel.name)).toEqual(["ml"]);
    expect(third.nextCursor).toBeNull();
  });

  it("narrows by name, ignoring case and a leading #", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.list", { provider: "slack", available: true, query: "#ENG" });
    const slack = (result as { output: { connections: Array<{ available: { channels: Array<{ name: string }> } }> } }).output.connections[0]!;
    expect(slack.available.channels.map((channel) => channel.name)).toEqual(["eng"]);
  });

  it("refuses a cursor it did not give", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.list", { provider: "slack", available: true, cursor: "garbage" });
    expect(result).toMatchObject({ status: "refused", code: "invalid_cursor" });
    expect((result as { message: string }).message).toContain("without a cursor");
  });

  it("says what is needed when available is used wrongly", async () => {
    const { invoke } = setup();
    expect(await invoke(person(), "connections.list", { available: true })).toMatchObject({ status: "refused", code: "provider_required" });
    const other = await invoke(person(), "connections.list", { provider: "linear", available: true });
    expect(other).toMatchObject({ status: "refused", code: "unsupported_action" });
    expect((other as { message: string }).message).toContain("slack");
    expect(await invoke(person(), "connections.list", { provider: "slack", query: "eng" })).toMatchObject({ status: "refused", code: "available_required" });
    expect(await invoke(person(), "connections.list", { provider: "slack", limit: 5 })).toMatchObject({ status: "refused", code: "available_required" });
  });

  it("is for people: a run may not browse every channel", async () => {
    const { invoke } = setup();
    const caller = runCaller(runSpec([{ tool: "connections.list", provider: "slack" }]));
    expect(await invoke(caller as never, "connections.list", { provider: "slack", available: true })).toMatchObject({ status: "refused", code: "not_allowed" });
  });

  it("says Slack is not connected, without failing the list", async () => {
    const { invoke } = setup({ connected: false });
    const result = await invoke(person(), "connections.list", { provider: "slack", available: true });
    const slack = (result as { output: { connections: Array<Record<string, unknown>> } }).output.connections[0]!;
    expect(slack.availableError).toContain("not connected");
    expect(slack.available).toBeUndefined();
  });

  it("lists the verbs a person may call on Slack, including join and leave", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.list", { provider: "slack" });
    const actions = (result as { output: { connections: Array<{ actions: Array<{ verb: string }> }> } }).output.connections[0]!.actions;
    expect(actions.map((action) => action.verb)).toEqual(["read", "post", "join", "leave"]);
  });
});

describe("connections.join", () => {
  it("joins only the channels named, keeping the ones the bot is in, and says what changed", async () => {
    const applied: string[][] = [];
    const update = applyTo(["C-general"]);
    const { invoke } = setup({ channels: { update: async (client, workspace, next) => { const result = await update(client, workspace, next); if (result.ok) applied.push(result.channelIds); return result; } } });
    const result = await invoke(person(), "connections.join", { provider: "slack", channels: ["#eng", "#general"] });
    expect(result).toMatchObject({
      status: "ok",
      output: {
        status: "joined",
        provider: "slack",
        changed: [{ id: "C-eng", name: "eng" }],
        unchanged: [{ id: "C-general", name: "general" }],
        failed: [],
        message: "Joined #eng. Already in #general.",
      },
    });
    expect(applied).toEqual([["C-general", "C-eng"]]);
  });

  it("says which channel could not be joined", async () => {
    const { invoke } = setup({ channels: { update: applyTo(["C-general"], [{ channelId: "C-eng", operation: "join", code: "slack_channel_join_failed" }]) } });
    const result = await invoke(person(), "connections.join", { provider: "slack", channels: ["#eng"] });
    expect(result).toMatchObject({ status: "ok", output: { changed: [], failed: [{ id: "C-eng", name: "eng", code: "slack_channel_join_failed" }], message: "Could not join #eng." } });
  });

  it("passes on a channel name that matches nothing, with what exists", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.join", { provider: "slack", channels: ["#nope"] });
    expect(result).toMatchObject({ status: "refused", code: "channel_not_found" });
    expect((result as { message: string }).message).toContain("#general");
  });

  it("refuses a provider without channels and names the ones that have them", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.join", { provider: "linear", channels: ["#eng"] });
    expect(result).toMatchObject({ status: "refused", code: "unsupported_action" });
    expect((result as { message: string }).message).toContain("slack");
  });

  it("tells a caller to connect Slack first", async () => {
    const { invoke } = setup({ connected: false });
    const result = await invoke(person(), "connections.join", { provider: "slack", channels: ["#eng"] });
    expect(result).toMatchObject({ status: "refused", code: "not_connected" });
    expect((result as { message: string }).message).toContain("connections.connect");
  });

  it("asks to try again when the connection changed at the same time", async () => {
    const { invoke } = setup({ channels: { update: async () => ({ ok: false, code: "connection_update_conflict", status: 409 }) } });
    const result = await invoke(person(), "connections.join", { provider: "slack", channels: ["#eng"] });
    expect(result).toMatchObject({ status: "refused", code: "connection_update_conflict" });
    expect((result as { message: string }).message).toContain("Try again");
  });

  it("is for people, not runs", async () => {
    const { invoke } = setup();
    const caller = runCaller(runSpec([{ tool: "connections.list", provider: "slack" }]));
    expect(await invoke(caller as never, "connections.join", { provider: "slack", channels: ["#eng"] })).toMatchObject({ status: "denied" });
  });

  it("needs at least one channel", async () => {
    const { invoke } = setup();
    expect(await invoke(person(), "connections.join", { provider: "slack", channels: [] })).toMatchObject({ status: "invalid" });
  });
});

describe("connections.leave", () => {
  it("leaves only the channels named and keeps the rest", async () => {
    const applied: string[][] = [];
    const update = applyTo(["C-general", "C-eng", "C-ops"]);
    const { invoke } = setup({ channels: { update: async (client, workspace, next) => { const result = await update(client, workspace, next); if (result.ok) applied.push(result.channelIds); return result; } } });
    const result = await invoke(person(), "connections.leave", { provider: "slack", channels: ["#eng"] });
    expect(result).toMatchObject({ status: "ok", output: { status: "left", changed: [{ id: "C-eng", name: "eng" }], unchanged: [], message: "Left #eng." } });
    expect(applied).toEqual([["C-general", "C-ops"]]);
  });

  it("says when the bot was not in the channel", async () => {
    const { invoke } = setup({ channels: { update: applyTo(["C-general"]) } });
    const result = await invoke(person(), "connections.leave", { provider: "slack", channels: ["#eng"] });
    expect(result).toMatchObject({ status: "ok", output: { changed: [], unchanged: [{ id: "C-eng", name: "eng" }], message: "Was not in #eng." } });
  });
});
