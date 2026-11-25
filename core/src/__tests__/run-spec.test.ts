import { describe, expect, it } from "bun:test";
import { AGENT_RUN_SYSTEM_REASONS, SANDBOX_RUN_DIRECTORY, executionProblem, networkOf, runtimeOfTarget, sandboxComputer, parseAgentEventId, parseAgentRunId, parseContextVersionId, parseHostId, parseIsoTimestamp, parseWorkspaceId, type AgentRunSpec } from "../run-spec";
import { DRAFT_TOOLS, findToolPermission, isDraftToolName } from "../tools";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function spec(permissions: AgentRunSpec["permissions"]): AgentRunSpec {
  return {
    id: parseAgentRunId(UUID_A),
    kind: "routine",
    workspaceId: parseWorkspaceId(UUID_B),
    trigger: { type: "cron", scheduledTaskId: UUID_A as never, occurrenceAt: parseIsoTimestamp("2026-11-09T09:00:00Z") },
    onBehalfOf: null,
    execution: { target: { type: "host", hostId: parseHostId("mac-1") }, adapterId: "claude-terminal" },
    toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] },
    computer: { type: "host_computer", computerId: "mac-1", workingDirectory: "/work" },
    harness: "claude",
    model: null,
    instructions: "do the thing",
    inputs: { contextVersionId: parseContextVersionId(UUID_A) },
    permissions,
    output: { type: "text" },
  };
}

describe("agent run ids", () => {
  it("accepts UUIDs and rejects anything else", () => {
    expect(parseWorkspaceId(UUID_A)).toBe(UUID_A as never);
    expect(() => parseWorkspaceId("not-a-uuid")).toThrow("Invalid WorkspaceId");
    expect(() => parseAgentRunId("")).toThrow("Invalid AgentRunId");
  });

  it("validates timestamps and host ids", () => {
    expect(() => parseIsoTimestamp("yesterday")).toThrow("Invalid IsoTimestamp");
    expect(() => parseHostId("  ")).toThrow("Invalid HostId");
  });
});

describe("event triggers", () => {
  it("accepts UUID agent event ids and rejects provider-style ids", () => {
    expect(parseAgentEventId(UUID_A)).toBe(UUID_A as never);
    expect(() => parseAgentEventId("evt_123")).toThrow("Invalid AgentEventId");
  });

  it("carries the agent events that woke a run", () => {
    const run: AgentRunSpec = { ...spec([]), trigger: { type: "event", eventIds: [parseAgentEventId(UUID_A), parseAgentEventId(UUID_B)] } };
    expect(run.trigger).toEqual({ type: "event", eventIds: [UUID_A, UUID_B] as never });
  });
});

describe("draft tools", () => {
  it("has unique tool names", () => {
    expect(new Set(DRAFT_TOOLS.map((tool) => tool.name)).size).toBe(DRAFT_TOOLS.length);
  });

  it("recognises only listed tool names", () => {
    expect(isDraftToolName("context.write")).toBe(true);
    expect(isDraftToolName("made.up_tool")).toBe(false);
    expect(isDraftToolName(3)).toBe(false);
  });
});

describe("system triggers", () => {
  it("lists the reasons Draft starts a run on its own", () => {
    expect(AGENT_RUN_SYSTEM_REASONS).toEqual(["manual", "source_threshold", "stale_requeue", "seed_test"]);
  });
});

describe("findToolPermission", () => {
  it("returns the permission for a granted tool and null for any other", () => {
    const run = spec([{ tool: "context.write", limits: { pathPrefixes: ["memory/"] } }]);
    expect(findToolPermission(run, "context.write")).toEqual({ tool: "context.write", limits: { pathPrefixes: ["memory/"] } });
    expect(findToolPermission(run, "context.read")).toBeNull();
  });

  it("finds a permission for a tool and provider, and not for another provider", () => {
    const slack = { tool: "connections.post", provider: "slack", limits: { channels: "joined" } } as const;
    const run = spec([slack, { tool: "connections.read", provider: "slack" }]);
    expect(findToolPermission(run, "connections.post", "slack")).toEqual(slack);
    expect(findToolPermission(run, "connections.post", "linear")).toBeNull();
    expect(findToolPermission(run, "connections.post")).toEqual(slack);
    expect(findToolPermission(run, "connections.list", "slack")).toBeNull();
  });

  it("does not take a permission without a provider as one for a provider", () => {
    const run = spec([{ tool: "connections.post" }]);
    expect(findToolPermission(run, "connections.post", "slack")).toBeNull();
    expect(findToolPermission(run, "connections.post")).toEqual({ tool: "connections.post" });
  });
});

describe("execution combinations", () => {
  const host = { type: "host", hostId: parseHostId("mac-1") } as const;
  const hostComputer = { type: "host_computer", computerId: "mac-1", workingDirectory: "/work" } as const;
  const sandboxPolicy = sandboxComputer("restricted", SANDBOX_RUN_DIRECTORY);
  const check = (harness: "claude" | "codex", adapterId: AgentRunSpec["execution"]["adapterId"], target: AgentRunSpec["execution"]["target"], computer: AgentRunSpec["computer"]) =>
    executionProblem({ harness, execution: { target, adapterId }, computer });

  it("allows each target an adapter supports, with a matching computer", () => {
    expect(check("claude", "claude-terminal", host, hostComputer)).toBeNull();
    expect(check("codex", "codex-app-server", host, hostComputer)).toBeNull();
    expect(check("claude", "claude-terminal", { type: "sandbox" }, sandboxPolicy)).toBeNull();
    expect(check("claude", "claude-print", { type: "sandbox" }, sandboxPolicy)).toBeNull();
    expect(check("codex", "codex-exec", { type: "sandbox" }, sandboxPolicy)).toBeNull();
    expect(check("claude", "claude-terminal", host, { type: "none" })).toBeNull();
  });

  it("refuses a target the adapter does not support, such as Codex live sessions in a sandbox", () => {
    expect(check("codex", "codex-app-server", { type: "sandbox" }, sandboxPolicy)).toContain("cannot run on a sandbox target");
    expect(check("claude", "claude-print", host, hostComputer)).toContain("cannot run on a host target");
    expect(check("claude", "claude-terminal", { type: "backend", packageVersion: "1" }, sandboxPolicy)).toContain("cannot run on a backend target");
  });

  it("refuses an adapter of another harness, an unknown adapter, and a computer from the wrong place", () => {
    expect(check("codex", "claude-terminal", host, hostComputer)).toContain("does not run harness codex");
    expect(check("claude", "future" as never, host, hostComputer)).toContain("Unknown adapter");
    expect(check("claude", "claude-terminal", host, sandboxPolicy)).toContain("host target cannot use a sandbox computer");
    expect(check("claude", "claude-terminal", { type: "sandbox" }, hostComputer)).toContain("sandbox target cannot use a host computer");
  });

  it("derives local or cloud from the target, and the network from the computer", () => {
    expect(runtimeOfTarget("host")).toBe("local");
    expect(runtimeOfTarget("sandbox")).toBe("cloud");
    expect(runtimeOfTarget("backend")).toBe("cloud");
    expect(networkOf(sandboxComputer("open", SANDBOX_RUN_DIRECTORY))).toBe("open");
    expect(networkOf(hostComputer)).toBe("restricted");
  });
});
