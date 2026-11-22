import { describe, expect, it } from "bun:test";
import { AGENT_RUN_SYSTEM_REASONS, parseAgentEventId, parseAgentRunId, parseContextVersionId, parseHostId, parseIsoTimestamp, parseWorkspaceId, type AgentRunSpec } from "../run-spec";
import { DRAFT_TOOLS, findToolPermission, isDraftToolName } from "../tools";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function spec(permissions: AgentRunSpec["permissions"]): AgentRunSpec {
  return {
    id: parseAgentRunId(UUID_A),
    kind: "routine",
    network: "open",
    workspaceId: parseWorkspaceId(UUID_B),
    trigger: { type: "cron", scheduledTaskId: UUID_A as never, occurrenceAt: parseIsoTimestamp("2026-11-09T09:00:00Z") },
    onBehalfOf: null,
    runtime: { type: "local", hostId: parseHostId("mac-1") },
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
