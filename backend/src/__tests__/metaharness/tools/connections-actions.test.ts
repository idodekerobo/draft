import { SANDBOX_RUN_DIRECTORY, sandboxComputer, sandboxExecution } from "draft-core/run-spec";
import { describe, expect, it, mock } from "bun:test";
import { parseAgentRunId, parseContextVersionId, parseScheduledTaskId, parseIsoTimestamp, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { personCaller, runCaller, type AnyDraftToolPermission } from "draft-core/tools";
import { createIntegrationTools, type IntegrationToolDeps } from "../../../metaharness/tools/definitions/integrations";
import { invokeTool, type ToolCallRecord } from "../../../metaharness/tools/invoke-tool";
import { ToolRegistry } from "../../../metaharness/tools/tool-registry";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const TASK = "66666666-6666-4666-8666-666666666666";

const run = (permissions: AnyDraftToolPermission[]): AgentRunSpec => ({
  id: parseAgentRunId(RUN), kind: "routine",
  workspaceId: parseWorkspaceId(WS),
  trigger: { type: "cron", scheduledTaskId: parseScheduledTaskId(TASK), occurrenceAt: parseIsoTimestamp("2026-11-11T09:00:00.000Z") },
  onBehalfOf: parseUserId(OWNER),
  execution: sandboxExecution("claude-print"), toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] }, computer: sandboxComputer("open", SANDBOX_RUN_DIRECTORY),
  harness: "claude", model: null, instructions: "", inputs: { contextVersionId: parseContextVersionId("77777777-7777-4777-8777-777777777777") },
  permissions, output: { type: "text" },
});

const slackFetch = () => mock(async (input: Request | string | URL) => {
  if (String(input).includes("conversations.history")) {
    return Response.json({ ok: true, messages: [{ ts: "1", user: "U1", text: "hi" }], has_more: false, response_metadata: { next_cursor: "" } });
  }
  return Response.json({
    ok: true,
    channels: [{ id: "C1", name: "general", is_member: true }, { id: "C2", name: "private", is_member: false }],
    response_metadata: { next_cursor: "" },
  });
}) as unknown as typeof fetch;

function setup(slack: IntegrationToolDeps["slack"] = {}, connected = true) {
  const db = fakeDb({ connections: connected ? [{ workspace_id: WS, provider: "slack", status: "active", connected_by_user_id: OWNER }] : [] });
  const registry = new ToolRegistry(createIntegrationTools(fakeClient(db), {
    slack: { fetch: slackFetch(), credentialId: async () => "cred", botToken: async () => "xoxb-test", post: async () => {}, ...slack },
  }));
  const audits: ToolCallRecord[] = [];
  const invoke = (caller: ReturnType<typeof runCaller>, tool: string, args: unknown) =>
    invokeTool({ registry, audit: async (entry) => { audits.push(entry); }, authorizeUser: async () => null }, caller, tool, args);
  return { audits, invoke };
}

const person = () => personCaller({ userId: parseUserId(OWNER), workspaceId: parseWorkspaceId(WS), via: "cli" });
const asRun = (permissions: AnyDraftToolPermission[]) => runCaller(run(permissions));

describe("connections.post", () => {
  it("resolves #names to joined channels, attributes posts, and audits the provider and a summary", async () => {
    const posted: unknown[][] = [];
    const { audits, invoke } = setup({ attribution: async () => "🤖 Draft agent · running a routine for Uzo", post: async (...args) => { posted.push(args); } });
    const caller = asRun([{ tool: "connections.post", provider: "slack", limits: { channels: ["#general"], maxPerRun: 2 } }]);
    const result = await invoke(caller, "connections.post", { provider: "slack", channel: "#GENERAL", text: "Standup is at 10." });
    expect(result).toMatchObject({ status: "ok", output: { provider: "slack", channel: { id: "C1", name: "general" } } });
    expect(audits[0]?.resultSummary).toBe("Posted in #general");
    expect(audits[0]?.arguments).toEqual({ provider: "slack", channel: "#GENERAL" });
    expect(posted[0]).toEqual(["xoxb-test", "C1", "🤖 Draft agent · running a routine for Uzo\nStandup is at 10.", expect.any(Function)]);
  });

  it("denies a run with no permission for the provider, and names the provider", async () => {
    const { invoke } = setup();
    const caller = asRun([{ tool: "connections.post", provider: "slack" }]);
    const result = await invoke(caller, "connections.post", { provider: "linear", channel: "x", text: "hello" });
    expect(result).toMatchObject({ status: "denied", code: "not_permitted" });
    expect((result as { message: string }).message).toContain("linear");
    const none = await invoke(asRun([{ tool: "connections.read", provider: "slack" }]), "connections.post", { provider: "slack", channel: "C1", text: "hello" });
    expect(none).toMatchObject({ status: "denied", code: "not_permitted" });
  });

  it("refuses non-member channels and channels outside the routine allowance, naming what would work", async () => {
    const { invoke } = setup();
    const caller = asRun([{ tool: "connections.post", provider: "slack", limits: { channels: ["C1"] } }]);
    const attempt = (channel: string) => invoke(caller, "connections.post", { provider: "slack", channel, text: "hello" });
    const notMember = await attempt("#private");
    expect(notMember).toMatchObject({ status: "refused", code: "channel_not_allowed" });
    expect((notMember as { message: string }).message).toContain("#general");
    expect(await attempt("#general")).toMatchObject({ status: "ok" });
    const outside = await invoke(asRun([{ tool: "connections.post", provider: "slack", limits: { channels: ["C2"] } }]), "connections.post", { provider: "slack", channel: "#general", text: "hello" });
    expect(outside).toMatchObject({ status: "refused", code: "channel_not_allowed" });
    expect((outside as { message: string }).message).toContain("C2");
  });

  it("counts a run's posts per tool and provider against maxPerRun", async () => {
    const counted: unknown[][] = [];
    const { invoke } = setup({ countCalls: async (...args) => { counted.push(args); return 1; } });
    const caller = asRun([{ tool: "connections.post", provider: "slack", limits: { maxPerRun: 1 } }]);
    const result = await invoke(caller, "connections.post", { provider: "slack", channel: "C1", text: "hello" });
    expect(result).toMatchObject({ status: "refused", code: "limit_reached" });
    expect(counted).toEqual([[RUN, "connections.post", "slack"]]);
  });

  it("says which providers can post when asked for one that cannot", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.post", { provider: "linear", channel: "x", text: "hello" });
    expect(result).toMatchObject({ status: "refused", code: "unsupported_action" });
    expect((result as { message: string }).message).toContain("slack");
  });

  it("tells a caller to connect Slack when it is not connected", async () => {
    const { invoke } = setup({ credentialId: async () => null });
    const result = await invoke(person(), "connections.post", { provider: "slack", channel: "C1", text: "hello" });
    expect(result).toMatchObject({ status: "refused", code: "slack_not_connected" });
    expect((result as { message: string }).message).toContain("connections.connect");
  });
});

describe("connections.read", () => {
  it("reads messages from a joined channel for a run that holds the permission", async () => {
    const { invoke } = setup();
    const result = await invoke(asRun([{ tool: "connections.read", provider: "slack" }]), "connections.read", { provider: "slack", channel: "#general", limit: 5 });
    expect(result).toMatchObject({ status: "ok", output: { provider: "slack", channel: { id: "C1", name: "general" }, messages: [{ text: "hi" }], has_more: false } });
  });

  it("denies a run that holds only the post permission", async () => {
    const { invoke } = setup();
    const result = await invoke(asRun([{ tool: "connections.post", provider: "slack" }]), "connections.read", { provider: "slack", channel: "C1" });
    expect(result).toMatchObject({ status: "denied", code: "not_permitted" });
  });

  it("says which providers can read when asked for one that cannot", async () => {
    const { invoke } = setup();
    expect(await invoke(person(), "connections.read", { provider: "linear", channel: "x" })).toMatchObject({ status: "refused", code: "unsupported_action" });
  });
});

describe("connections.list", () => {
  it("gives a person every provider with the verbs they may call, and Slack's joined channels", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.list", {});
    const connections = (result as { output: { connections: Array<Record<string, unknown>> } }).output.connections;
    const slack = connections.find((item) => item.provider === "slack")!;
    expect(slack).toMatchObject({ status: "connected", channels: [{ id: "C1", name: "general" }] });
    expect((slack.actions as Array<{ verb: string }>).map((action) => action.verb)).toEqual(["read", "post", "join", "leave"]);
    expect(connections.find((item) => item.provider === "linear")?.actions).toEqual([]);
  });

  it("can be narrowed to one provider", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.list", { provider: "slack" });
    expect((result as { output: { connections: unknown[] } }).output.connections).toHaveLength(1);
  });

  it("shows a run only the providers and verbs it holds permissions for", async () => {
    const { invoke } = setup();
    const caller = asRun([{ tool: "connections.list", provider: "slack" }, { tool: "connections.read", provider: "slack" }]);
    const result = await invoke(caller, "connections.list", {});
    const connections = (result as { output: { connections: Array<{ provider: string; actions: Array<{ verb: string }> }> } }).output.connections;
    expect(connections.map((item) => item.provider)).toEqual(["slack"]);
    expect(connections[0]!.actions.map((action) => action.verb)).toEqual(["read"]);
  });

  it("denies a run with no list permission, or one asking for a provider it does not hold", async () => {
    const { invoke } = setup();
    expect(await invoke(asRun([{ tool: "connections.read", provider: "slack" }]), "connections.list", {})).toMatchObject({ status: "denied", code: "not_permitted" });
    expect(await invoke(asRun([{ tool: "connections.list", provider: "slack" }]), "connections.list", { provider: "linear" })).toMatchObject({ status: "denied", code: "not_permitted" });
  });

  it("reports a channel listing failure without failing the list", async () => {
    const failing = mock(async () => { throw new Error("network"); }) as unknown as typeof fetch;
    const { invoke } = setup({ fetch: failing });
    const result = await invoke(person(), "connections.list", { provider: "slack" });
    const slack = (result as { output: { connections: Array<Record<string, unknown>> } }).output.connections[0]!;
    expect(slack.channelsError).toContain("Could not list Slack channels");
  });
});
