import { describe, expect, it } from "bun:test";
import { AGENT_RUN_KINDS, parseAgentRunId, parseContextVersionId, parseHostId, parseUserId, parseWorkspaceId, type AgentRunSpec } from "../run-spec";
import { ANY_RUN, originKind, personCaller, runCaller } from "../tools";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "44444444-4444-4444-8444-444444444444";

function run(overrides: Partial<AgentRunSpec> = {}): AgentRunSpec {
  return {
    id: parseAgentRunId(RUN_ID),
    kind: "routine",
    workspaceId: parseWorkspaceId(WORKSPACE_ID),
    trigger: { type: "manual", requestedBy: parseUserId(USER_ID) },
    onBehalfOf: parseUserId(OWNER_ID),
    execution: { target: { type: "host", hostId: parseHostId("mac-1") }, adapterId: "claude-terminal" },
    toolset: { nativeTools: [], mcpServers: [], skills: [], instructions: [] },
    computer: { type: "host_computer", computerId: "mac-1", workingDirectory: "/work" },
    harness: "claude",
    model: null,
    instructions: "do the thing",
    inputs: { contextVersionId: parseContextVersionId(RUN_ID) },
    permissions: [],
    output: { type: "text" },
    ...overrides,
  };
}

describe("personCaller", () => {
  it("makes the person their own onBehalfOf and keeps the surface", () => {
    const caller = personCaller({ userId: parseUserId(USER_ID), workspaceId: parseWorkspaceId(WORKSPACE_ID), via: "mcp" });
    expect(caller).toEqual({
      workspaceId: parseWorkspaceId(WORKSPACE_ID),
      onBehalfOf: parseUserId(USER_ID),
      origin: { kind: "person", userId: parseUserId(USER_ID), via: "mcp" },
    });
  });
});

describe("runCaller", () => {
  it("takes the workspace and onBehalfOf from the run's spec", () => {
    const spec = run();
    expect(runCaller(spec)).toEqual({ workspaceId: parseWorkspaceId(WORKSPACE_ID), onBehalfOf: parseUserId(OWNER_ID), origin: { kind: "run", run: spec } });
  });

  it("keeps onBehalfOf null for a run on shared data", () => {
    expect(runCaller(run({ onBehalfOf: null })).onBehalfOf).toBeNull();
  });
});

describe("originKind", () => {
  it("is person for a person, and the run's kind for a run", () => {
    expect(originKind(personCaller({ userId: parseUserId(USER_ID), workspaceId: parseWorkspaceId(WORKSPACE_ID), via: "cli" }))).toBe("person");
    expect(originKind(runCaller(run({ kind: "synthesis" })))).toBe("synthesis");
  });
});

describe("ANY_RUN", () => {
  it("allows every agent run kind and no person", () => {
    expect([...ANY_RUN]).toEqual([...AGENT_RUN_KINDS]);
    expect(ANY_RUN).not.toContain("person");
  });
});
