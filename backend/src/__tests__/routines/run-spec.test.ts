import { describe, expect, it } from "bun:test";
import { renderRoutinePrompt } from "../../routines/build-bundle";
import { buildRoutineRunSpec, ROUTINE_PERMISSIONS } from "../../routines/run-spec";

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

  it("grants reading and writing the shared context, with no path limit", () => {
    expect(ROUTINE_PERMISSIONS).toEqual([{ tool: "context.read" }, { tool: "context.write" }]);
  });

  it("rejects ids that are not UUIDs", () => {
    expect(() => buildRoutineRunSpec({ ...input, workspaceId: "ws-1" })).toThrow("Invalid WorkspaceId");
    expect(() => buildRoutineRunSpec({ ...input, occurrenceAt: "soon" })).toThrow("Invalid IsoTimestamp");
  });
});

describe("renderRoutinePrompt", () => {
  const context = { title: "Digest", schedule: "Daily", timezone: "UTC", startedAt: new Date("2026-11-09T09:00:00Z") };

  it("mentions Draft's tool server only when the run has one", () => {
    const withTools = renderRoutinePrompt("Go", { ...context, hasDraftTools: true });
    expect(withTools).toContain('"draft" tool server');
    expect(withTools).toContain("context.write");
    expect(withTools).toContain("baseSha");
    expect(renderRoutinePrompt("Go", context)).not.toContain("context.write");
    expect(renderRoutinePrompt("Go", context)).not.toContain("tool server");
  });
});
