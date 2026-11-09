import { describe, expect, it } from "bun:test";
import {
  AGENT_RUN_SYSTEM_REASONS,
  DRAFT_TOOLS,
  findToolPermission,
  isDraftToolName,
  parseAgentRunId,
  parseContextVersionId,
  parseHostMachineId,
  parseIsoTimestamp,
  parseWorkspaceId,
  type AgentRunSpec,
} from "../agent-run";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";

function spec(permissions: AgentRunSpec["permissions"]): AgentRunSpec {
  return {
    id: parseAgentRunId(UUID_A),
    kind: "routine",
    workspaceId: parseWorkspaceId(UUID_B),
    trigger: { type: "cron", scheduledTaskId: UUID_A as never, occurrenceAt: parseIsoTimestamp("2026-11-09T09:00:00Z") },
    principal: { type: "workspace" },
    runtime: { type: "local", hostMachineId: parseHostMachineId("mac-1") },
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

  it("validates timestamps and host machine ids", () => {
    expect(() => parseIsoTimestamp("yesterday")).toThrow("Invalid IsoTimestamp");
    expect(() => parseHostMachineId("  ")).toThrow("Invalid HostMachineId");
  });
});

describe("draft tools", () => {
  it("has unique tool names", () => {
    expect(new Set(DRAFT_TOOLS.map((tool) => tool.name)).size).toBe(DRAFT_TOOLS.length);
  });

  it("recognises only listed tool names", () => {
    expect(isDraftToolName("context.write")).toBe(true);
    expect(isDraftToolName("slack.post_message")).toBe(false);
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
});
