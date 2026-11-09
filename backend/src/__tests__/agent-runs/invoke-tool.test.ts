import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  parseAgentRunId,
  parseContextVersionId,
  parseHostMachineId,
  parseUserId,
  parseWorkspaceId,
  type AgentRunSpec,
  type AnyDraftToolPermission,
  type ToolCaller,
} from "draft-core/agent-run";
import { invokeTool, type ToolCallRecord } from "../../agent-runs/invoke-tool";
import { defineTool, ToolRegistry } from "../../agent-runs/tool-registry";

function runWith(permissions: AnyDraftToolPermission[]): ToolCaller {
  const run: AgentRunSpec = {
    id: parseAgentRunId("11111111-1111-4111-8111-111111111111"),
    kind: "routine",
    workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
    trigger: { type: "manual", requestedBy: parseUserId("33333333-3333-4333-8333-333333333333") },
    principal: { type: "workspace" },
    runtime: { type: "local", hostMachineId: parseHostMachineId("mac") },
    harness: "claude",
    model: null,
    instructions: "",
    inputs: { contextVersionId: parseContextVersionId("44444444-4444-4444-8444-444444444444") },
    permissions,
    output: { type: "text" },
  };
  return { type: "run", run };
}

function setup(options: { authorizeUser?: boolean } = {}) {
  const calls: string[] = [];
  const audits: ToolCallRecord[] = [];
  const registry = new ToolRegistry([
    defineTool({
      name: "context.read",
      description: "read",
      input: z.object({ path: z.string() }),
      handler: async ({ input }) => {
        calls.push(`read:${input.path}`);
        if (input.path === "boom") throw new Error("database exploded");
        return { status: "ok", output: { content: "hello" }, summary: `read ${input.path}` };
      },
    }),
    defineTool({
      name: "context.write",
      description: "write",
      input: z.object({ path: z.string(), content: z.string() }),
      checkLimits: (limits, input) =>
        limits?.pathPrefixes && !limits.pathPrefixes.some((prefix) => input.path.startsWith(prefix))
          ? `${input.path} is outside the allowed paths`
          : null,
      auditArguments: (input) => ({ path: input.path, bytes: input.content.length }),
      handler: async ({ input }) => {
        calls.push(`write:${input.path}`);
        return input.path === "stale.md"
          ? { status: "conflict", output: { currentSha: "abc" } }
          : { status: "ok", output: { sha: "def" } };
      },
    }),
  ]);
  const deps = {
    registry,
    audit: async (record: ToolCallRecord) => {
      audits.push(record);
    },
    authorizeUser: options.authorizeUser === undefined ? undefined : async () => (options.authorizeUser ? null : { status: 403, body: { error: "forbidden" } }),
    now: () => 1_000,
  };
  return { deps, calls, audits };
}

describe("invokeTool", () => {
  it("runs a permitted tool and writes an ok audit row", async () => {
    const { deps, calls, audits } = setup();
    const result = await invokeTool(deps, runWith([{ tool: "context.read" }]), "context.read", { path: "a.md" });
    expect(result).toEqual({ status: "ok", output: { content: "hello" } });
    expect(calls).toEqual(["read:a.md"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ toolName: "context.read", status: "ok", resultSummary: "read a.md", arguments: { path: "a.md" } });
  });

  it("denies a tool the run was not given, without running it", async () => {
    const { deps, calls, audits } = setup();
    const result = await invokeTool(deps, runWith([{ tool: "context.read" }]), "context.write", { path: "a.md", content: "x" });
    expect(result).toMatchObject({ status: "denied", code: "not_permitted" });
    expect(calls).toEqual([]);
    expect(audits[0]).toMatchObject({ status: "denied", errorCode: "not_permitted" });
  });

  it("denies an unknown tool name", async () => {
    const { deps, audits } = setup();
    const result = await invokeTool(deps, runWith([{ tool: "context.read" }]), "slack.post_message", {});
    expect(result).toMatchObject({ status: "denied", code: "unknown_tool" });
    expect(audits[0]).toMatchObject({ status: "denied" });
  });

  it("reports invalid input and does not run the handler", async () => {
    const { deps, calls, audits } = setup();
    const result = await invokeTool(deps, runWith([{ tool: "context.read" }]), "context.read", { path: 5 });
    expect(result.status).toBe("invalid");
    expect(calls).toEqual([]);
    expect(audits[0]).toMatchObject({ status: "invalid" });
  });

  it("enforces the permission's limits", async () => {
    const { deps, calls, audits } = setup();
    const caller = runWith([{ tool: "context.write", limits: { pathPrefixes: ["memory/"] } }]);
    const denied = await invokeTool(deps, caller, "context.write", { path: "company/about.md", content: "x" });
    expect(denied).toMatchObject({ status: "denied", code: "outside_limits" });
    expect(calls).toEqual([]);
    const allowed = await invokeTool(deps, caller, "context.write", { path: "memory/day.md", content: "x" });
    expect(allowed.status).toBe("ok");
    expect(audits.map((a) => a.status)).toEqual(["denied", "ok"]);
  });

  it("stores the tool's own audit view of its arguments, not the raw content", async () => {
    const { deps, audits } = setup();
    await invokeTool(deps, runWith([{ tool: "context.write" }]), "context.write", { path: "a.md", content: "secret body" });
    expect(audits[0].arguments).toEqual({ path: "a.md", bytes: 11 });
  });

  it("passes a conflict back to the agent and audits it as a conflict", async () => {
    const { deps, audits } = setup();
    const result = await invokeTool(deps, runWith([{ tool: "context.write" }]), "context.write", { path: "stale.md", content: "x" });
    expect(result).toEqual({ status: "conflict", output: { currentSha: "abc" } });
    expect(audits[0].status).toBe("conflict");
  });

  it("hides handler errors from the agent but keeps them in the audit row", async () => {
    const { deps, audits } = setup();
    const result = await invokeTool(deps, runWith([{ tool: "context.read" }]), "context.read", { path: "boom" });
    expect(result).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("exploded");
    expect(audits[0]).toMatchObject({ status: "error", resultSummary: "database exploded", errorCode: "handler_error" });
  });

  it("still returns the result when the audit write fails", async () => {
    const { deps } = setup();
    const failing = { ...deps, audit: async () => { throw new Error("db down"); } };
    const result = await invokeTool(failing, runWith([{ tool: "context.read" }]), "context.read", { path: "a.md" });
    expect(result.status).toBe("ok");
  });

  it("truncates very large audited arguments", async () => {
    const { deps, audits } = setup();
    await invokeTool(deps, runWith([{ tool: "context.read" }]), "context.read", { path: "x".repeat(20_000) });
    expect(audits[0].arguments).toMatchObject({ truncated: true });
  });

  it("denies person callers unless an authorizer allows them", async () => {
    const user: ToolCaller = {
      type: "user",
      userId: parseUserId("33333333-3333-4333-8333-333333333333"),
      workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
      via: "mcp",
    };
    const none = setup();
    expect(await invokeTool(none.deps, user, "context.read", { path: "a.md" })).toMatchObject({ status: "denied", code: "caller_not_authorized" });
    const allowed = setup({ authorizeUser: true });
    expect((await invokeTool(allowed.deps, user, "context.read", { path: "a.md" })).status).toBe("ok");
  });

  it("passes the refusal's status and body to the edge, and audits the refused call", async () => {
    const user: ToolCaller = {
      type: "user",
      userId: parseUserId("33333333-3333-4333-8333-333333333333"),
      workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
      via: "cli",
    };
    const refused = setup({ authorizeUser: false });
    const result = await invokeTool(refused.deps, user, "context.read", { path: "a.md" });
    expect(result).toMatchObject({ status: "denied", code: "caller_not_authorized", detail: { status: 403, body: { error: "forbidden" } } });
    expect(refused.calls).toEqual([]);
    expect(refused.audits[0]).toMatchObject({ status: "denied", caller: { type: "user", via: "cli" } });
  });

  it("audits a person's call with the size of what came back", async () => {
    const user: ToolCaller = {
      type: "user",
      userId: parseUserId("33333333-3333-4333-8333-333333333333"),
      workspaceId: parseWorkspaceId("22222222-2222-4222-8222-222222222222"),
      via: "mcp",
    };
    const allowed = setup({ authorizeUser: true });
    await invokeTool(allowed.deps, user, "context.read", { path: "a.md" });
    expect(allowed.audits[0]).toMatchObject({ caller: { type: "user" }, resultBytes: JSON.stringify({ content: "hello" }).length });
  });

  it("keeps a tool that needs a person away from a run, and away from a run's tool list", async () => {
    const personOnly = defineTool({ name: "sources.search", description: "s", callers: ["user"], input: z.object({}), handler: async () => ({ status: "ok", output: {} }) });
    const registry = new ToolRegistry([personOnly]);
    const run = runWith([{ tool: "sources.search" }]);
    if (run.type !== "run") throw new Error("unreachable");
    const audits: ToolCallRecord[] = [];
    const result = await invokeTool({ registry, audit: async (record) => void audits.push(record) }, run, "sources.search", {});
    expect(result).toMatchObject({ status: "denied", code: "caller_not_authorized" });
    expect(registry.listFor(run.run)).toEqual([]);
    expect(registry.listForUser().map((tool) => tool.name)).toEqual(["sources.search"]);
  });
});

describe("ToolRegistry", () => {
  it("lists only the tools a run was given", () => {
    const { deps } = setup();
    const caller = runWith([{ tool: "context.write" }]);
    if (caller.type !== "run") throw new Error("unreachable");
    expect(deps.registry.listFor(caller.run).map((tool) => tool.name)).toEqual(["context.write"]);
  });

  it("refuses to register one tool twice", () => {
    const tool = defineTool({ name: "request_input", description: "", input: z.object({}), handler: async () => ({ status: "ok", output: {} }) });
    expect(() => new ToolRegistry([tool, tool])).toThrow("registered twice");
  });
});
