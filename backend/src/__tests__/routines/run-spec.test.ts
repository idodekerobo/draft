import { describe, expect, it } from "bun:test";
import { renderRoutinePrompt } from "../../routines/build-bundle";
import { buildRoutineRunSpec, ROUTINE_PERMISSIONS, routineEnvironment } from "../../routines/run-spec";

const input = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  scheduledTaskId: "55555555-5555-4555-8555-555555555555",
  occurrenceAt: "2026-11-09T09:00:00.000Z",
  routine: { title: "Digest", prompt: "Summarize.", harness: "claude" as const, model: null },
  contextVersionId: "44444444-4444-4444-8444-444444444444",
};

describe("buildRoutineRunSpec", () => {
  it("builds a cloud routine spec for the workspace, from its schedule", () => {
    const spec = buildRoutineRunSpec(input);
    expect(spec).toMatchObject({
      kind: "routine",
      principal: { type: "workspace" },
      harness: "claude",
      model: null,
      instructions: "Summarize.",
      output: { type: "text" },
      trigger: { type: "cron", scheduledTaskId: input.scheduledTaskId, occurrenceAt: input.occurrenceAt },
      inputs: { contextVersionId: input.contextVersionId },
    });
    expect(spec.runtime.type).toBe("cloud");
  });

  it("grants reading, and no write to the shared context yet", () => {
    const tools = ROUTINE_PERMISSIONS.map((permission) => permission.tool);
    expect(tools).toEqual(["context.read"]);
    expect(tools).not.toContain("context.write");
  });

  it("rejects ids that are not UUIDs", () => {
    expect(() => buildRoutineRunSpec({ ...input, workspaceId: "ws-1" })).toThrow("Invalid WorkspaceId");
    expect(() => buildRoutineRunSpec({ ...input, occurrenceAt: "soon" })).toThrow("Invalid IsoTimestamp");
  });

  it("lists the built-in tools the runner starts each harness with", () => {
    expect(routineEnvironment("claude").nativeTools).toEqual([{ harness: "claude", tool: "Read" }, { harness: "claude", tool: "Glob" }]);
    expect(routineEnvironment("codex").nativeTools).toEqual([{ harness: "codex", tool: "shell" }]);
    expect(routineEnvironment("claude").mcpServers).toEqual([]);
  });
});

describe("renderRoutinePrompt", () => {
  const context = { title: "Digest", schedule: "Daily", timezone: "UTC", startedAt: new Date("2026-11-09T09:00:00Z") };

  it("mentions Draft's tool server only when the run has one", () => {
    expect(renderRoutinePrompt("Go", { ...context, hasDraftTools: true })).toContain('"draft" tool server');
    expect(renderRoutinePrompt("Go", context)).not.toContain("tool server");
  });
});
