import { SANDBOX_RUN_DIRECTORY, sandboxComputer, sandboxExecution } from "draft-core/run-spec";
import { describe, expect, it } from "bun:test";
import { parseAgentRunId, parseContextVersionId, parseScheduledTaskId, parseIsoTimestamp, parseUserId, parseWorkspaceId, type AgentRunSpec } from "draft-core/run-spec";
import { personCaller, runCaller, type AnyDraftToolPermission } from "draft-core/tools";
import type { ConnectionAdapter, ReadInput, ScopeInput, SearchInput } from "../../../metaharness/tools/connection-adapters";
import { createIntegrationTools } from "../../../metaharness/tools/definitions/integrations";
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

function setup() {
  const seen = { search: [] as SearchInput[], read: [] as ReadInput[], join: [] as ScopeInput[] };
  const mail: ConnectionAdapter = {
    provider: "fireflies",
    notConnectedMessage: "not connected",
    actions: [
      { verb: "search", description: "Search mail.", fields: { query: "required" } },
      { verb: "read", description: "Read mail.", fields: { messageId: "required" } },
      { verb: "join", description: "Pick folders.", fields: { folders: "required" }, personOnly: true },
    ],
    search: async (_context, input) => {
      seen.search.push(input);
      return { status: "ok", output: { provider: "fireflies", results: [{ id: "m1", title: "Cal meeting", snippet: "at 10", date: "2026-11-10" }], nextCursor: "next" } };
    },
    read: async (_context, input) => {
      seen.read.push(input);
      return { status: "ok", output: { provider: "fireflies", id: input.messageId } };
    },
    join: async (_context, input) => {
      seen.join.push(input);
      return { status: "ok", output: { status: "joined", provider: "fireflies" } };
    },
    audit: (verb, input) => (verb === "search" ? { provider: "fireflies", limit: input.limit ?? null } : { provider: "fireflies" }),
  };
  const registry = new ToolRegistry(createIntegrationTools(fakeClient(fakeDb({ connections: [] })), { adapters: [mail] }));
  const audits: ToolCallRecord[] = [];
  const invoke = (caller: ReturnType<typeof runCaller>, tool: string, args: unknown) =>
    invokeTool({ registry, audit: async (entry) => { audits.push(entry); }, authorizeUser: async () => null }, caller, tool, args);
  return { audits, invoke, seen };
}

const person = () => personCaller({ userId: parseUserId(OWNER), workspaceId: parseWorkspaceId(WS), via: "cli" });
const asRun = (permissions: AnyDraftToolPermission[]) => runCaller(run(permissions));

describe("connections.search", () => {
  it("passes the query and filters to the provider's adapter and returns its page", async () => {
    const { invoke, seen } = setup();
    const result = await invoke(person(), "connections.search", { provider: "fireflies", query: "\"cal meeting\"", since: "2026-11-01", limit: 5, cursor: "c1" });
    expect(result).toMatchObject({ status: "ok", output: { provider: "fireflies", nextCursor: "next", results: [{ id: "m1" }] } });
    expect(seen.search).toEqual([{ query: "\"cal meeting\"", since: "2026-11-01", limit: 5, cursor: "c1" }]);
  });

  it("audits what the adapter keeps, never the query", async () => {
    const { audits, invoke } = setup();
    await invoke(person(), "connections.search", { provider: "fireflies", query: "secret words", limit: 5 });
    expect(audits[0]?.arguments).toEqual({ provider: "fireflies", limit: 5 });
  });

  it("lets a run search only the providers it holds a permission for", async () => {
    const { invoke } = setup();
    const allowed = await invoke(asRun([{ tool: "connections.search", provider: "fireflies" }]), "connections.search", { provider: "fireflies", query: "x" });
    expect(allowed).toMatchObject({ status: "ok" });
    const other = await invoke(asRun([{ tool: "connections.search", provider: "slack" }]), "connections.search", { provider: "fireflies", query: "x" });
    expect(other).toMatchObject({ status: "denied", code: "not_permitted" });
    const none = await invoke(asRun([{ tool: "connections.read", provider: "fireflies" }]), "connections.search", { provider: "fireflies", query: "x" });
    expect(none).toMatchObject({ status: "denied", code: "not_permitted" });
  });

  it("refuses a provider without search, and points Slack to stored messages", async () => {
    const { invoke } = setup();
    const linear = await invoke(person(), "connections.search", { provider: "linear", query: "x" });
    expect(linear).toMatchObject({ status: "refused", code: "unsupported_action" });
    expect((linear as { message: string }).message).toContain("fireflies");
    const slack = await invoke(person(), "connections.search", { provider: "slack", query: "x" });
    expect((slack as { message: string }).message).toContain("sources.search");
  });
});

describe("connections.read and join on a provider that is not Slack", () => {
  it("forwards the provider's own fields and leaves out provider", async () => {
    const { invoke, seen } = setup();
    await invoke(person(), "connections.read", { provider: "fireflies", messageId: "m1", maxBytes: 100 });
    expect(seen.read).toEqual([{ messageId: "m1", maxBytes: 100 }]);
  });

  it("joins folders for a person, and a run cannot", async () => {
    const { invoke, seen } = setup();
    const ok = await invoke(person(), "connections.join", { provider: "fireflies", folders: ["f1"] });
    expect(ok).toMatchObject({ status: "ok" });
    expect(seen.join).toEqual([{ channels: undefined, folders: ["f1"] }]);
    const denied = await invoke(asRun([{ tool: "connections.list" }]), "connections.join", { provider: "fireflies", folders: ["f1"] });
    expect(denied).toMatchObject({ status: "denied" });
  });

  it("tells Slack it needs channels when none are given", async () => {
    const { invoke } = setup();
    const result = await invoke(person(), "connections.join", { provider: "slack", folders: ["f1"] });
    expect(result).toMatchObject({ status: "refused", code: "channels_required" });
  });
});
