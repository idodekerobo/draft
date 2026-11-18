import { describe, expect, it, mock } from "bun:test";
import { parseAgentRunId, parseContextVersionId, parseScheduledTaskId, parseIsoTimestamp, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { personCaller, runCaller, type AnyDraftToolPermission } from "draft-core/tools";
import { createSlackTools } from "../../../metaharness/tools/definitions/slack";
import { invokeTool } from "../../../metaharness/tools/invoke-tool";
import { ToolRegistry } from "../../../metaharness/tools/tool-registry";
import { fakeClient, fakeDb } from "../../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const TASK = "66666666-6666-4666-8666-666666666666";

const run = (permissions: AnyDraftToolPermission[]): AgentRunSpec => ({
  id: parseAgentRunId(RUN), kind: "routine", network: "open",
  workspaceId: parseWorkspaceId(WS),
  trigger: { type: "cron", scheduledTaskId: parseScheduledTaskId(TASK), occurrenceAt: parseIsoTimestamp("2026-11-11T09:00:00.000Z") },
  onBehalfOf: parseUserId(OWNER),
  runtime: { type: "cloud", toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] } },
  harness: "claude", model: null, instructions: "", inputs: { contextVersionId: parseContextVersionId("77777777-7777-4777-8777-777777777777") },
  permissions, output: { type: "text" },
});

describe("Slack tools", () => {
  it("resolves #names to joined channels, attributes posts, and returns an audit summary", async () => {
    const posted: unknown[][] = [];
    const fetchFn = mock(async () => Response.json({ ok: true, channels: [
      { id: "C1", name: "general", is_member: true }, { id: "C2", name: "private", is_member: false },
    ], response_metadata: { next_cursor: "" } })) as unknown as typeof fetch;
    const registry = new ToolRegistry(createSlackTools(fakeClient(fakeDb()), {
      fetch: fetchFn, credentialId: async () => "cred", botToken: async () => "xoxb-test",
      attribution: async () => "🤖 Draft agent · running a routine for Uzo",
      post: async (...args) => { posted.push(args); },
    }));
    const audits: Array<{ resultSummary: string | null }> = [];
    const caller = runCaller(run([{ tool: "slack.post_message", limits: { channels: ["#general"], maxPerRun: 2 } }]));
    const result = await invokeTool({ registry, audit: async (entry) => { audits.push(entry); }, authorizeUser: async () => null }, caller, "slack.post_message", { channel: "#GENERAL", text: "Standup is at 10." });
    expect(result).toMatchObject({ status: "ok" });
    expect(audits[0]?.resultSummary).toBe("Posted in #general");
    expect(posted[0]).toEqual(["xoxb-test", "C1", "🤖 Draft agent · running a routine for Uzo\nStandup is at 10.", expect.any(Function)]);
  });

  it("refuses non-member channels and channels outside the routine allowance", async () => {
    const fetchFn = mock(async () => Response.json({ ok: true, channels: [
      { id: "C1", name: "general", is_member: true }, { id: "C2", name: "private", is_member: false },
    ], response_metadata: { next_cursor: "" } })) as unknown as typeof fetch;
    const registry = new ToolRegistry(createSlackTools(fakeClient(fakeDb()), { fetch: fetchFn, credentialId: async () => "cred", botToken: async () => "xoxb-test", post: async () => {} }));
    const caller = runCaller(run([{ tool: "slack.post_message", limits: { channels: ["C1"] } }]));
    const invoke = (channel: string) => invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, caller, "slack.post_message", { channel, text: "hello" });
    expect(await invoke("#private")).toMatchObject({ status: "refused", code: "channel_not_allowed" });
    expect(await invoke("#general")).toMatchObject({ status: "ok" });
    const denied = runCaller(run([{ tool: "slack.post_message", limits: { channels: ["C2"] } }]));
    expect(await invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, denied, "slack.post_message", { channel: "#general", text: "hello" })).toMatchObject({ status: "refused", code: "channel_not_allowed" });
  });

  it("enforces maxPerRun and lists only channels the bot has joined", async () => {
    const fetchFn = mock(async () => Response.json({ ok: true, channels: [
      { id: "C1", name: "general", is_member: true }, { id: "C2", name: "private", is_member: false },
    ], response_metadata: { next_cursor: "" } })) as unknown as typeof fetch;
    const registry = new ToolRegistry(createSlackTools(fakeClient(fakeDb()), {
      fetch: fetchFn, credentialId: async () => "cred", botToken: async () => "xoxb-test", post: async () => {}, countCalls: async () => 1,
    }));
    const caller = runCaller(run([{ tool: "slack.post_message", limits: { maxPerRun: 1 } }]));
    const result = await invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, caller, "slack.post_message", { channel: "C1", text: "hello" });
    expect(result).toMatchObject({ status: "refused", code: "limit_reached" });
    const user = personCaller({ userId: parseUserId(OWNER), workspaceId: parseWorkspaceId(WS), via: "cli" });
    const channels = await invokeTool({ registry, audit: async () => {}, authorizeUser: async () => null }, user, "slack.list_channels", {});
    expect(channels).toMatchObject({ status: "ok", output: [{ id: "C1", name: "general" }] });
  });
});
