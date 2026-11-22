import { describe, expect, it } from "bun:test";
import type { AnyDraftToolPermission } from "draft-core/tools";
import { renderRoutinePrompt } from "../../routines/build-bundle";
import { buildRoutineRunSpec, ROUTINE_CREATE_MAX_PER_RUN, ROUTINE_PERMISSIONS, routinePermissions } from "../../routines/run-spec";

const input = {
  id: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  scheduledTaskId: "55555555-5555-4555-8555-555555555555",
  ownerUserId: "66666666-6666-4666-8666-666666666666",
  occurrenceAt: "2026-11-09T09:00:00.000Z",
  routine: { title: "Digest", prompt: "Summarize.", harness: "claude" as const, model: null },
  contextVersionId: "44444444-4444-4444-8444-444444444444",
};

describe("buildRoutineRunSpec", () => {
  it("builds a cloud routine spec that acts as its owner, from its schedule", () => {
    const spec = buildRoutineRunSpec(input);
    expect(spec).toMatchObject({
      kind: "routine",
      onBehalfOf: input.ownerUserId,
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
    expect(ROUTINE_PERMISSIONS).toEqual([
      { tool: "context.read" }, { tool: "context.list" }, { tool: "context.write" },
      { tool: "sources.search" }, { tool: "sources.read" }, { tool: "skills.list" }, { tool: "skills.read" },
    ]);
  });

  it("rejects ids that are not UUIDs", () => {
    expect(() => buildRoutineRunSpec({ ...input, workspaceId: "ws-1" })).toThrow("Invalid WorkspaceId");
    expect(() => buildRoutineRunSpec({ ...input, occurrenceAt: "soon" })).toThrow("Invalid IsoTimestamp");
  });
});

describe("routine permissions", () => {
  const ROUTINE_TOOLS: AnyDraftToolPermission[] = [
    { tool: "routines.create", limits: { maxPerRun: 5 } }, { tool: "routines.update" }, { tool: "routines.delete" },
    { tool: "routines.list" }, { tool: "routines.run" }, { tool: "routines.runs" },
  ];

  it("gives a plain routine context and the routine tools, and a canNotify routine people.find and a capped notify to members", () => {
    expect(routinePermissions({})).toEqual([...ROUTINE_PERMISSIONS, ...ROUTINE_TOOLS]);
    expect(routinePermissions({ canNotify: true })).toEqual([
      ...ROUTINE_PERMISSIONS,
      ...ROUTINE_TOOLS,
      { tool: "people.find" },
      { tool: "people.notify", limits: { recipients: "members", maxPerRun: 15 } },
    ]);
  });

  it("gives a routine that may post to Slack list, read and capped post permissions for the slack provider", () => {
    expect(routinePermissions({ postChannels: ["#standup"] })).toEqual([
      ...ROUTINE_PERMISSIONS,
      ...ROUTINE_TOOLS,
      { tool: "connections.list", provider: "slack" },
      { tool: "connections.read", provider: "slack" },
      { tool: "connections.post", provider: "slack", limits: { channels: ["#standup"], maxPerRun: 10 } },
    ]);
    expect(routinePermissions({ postChannels: "joined" })).toContainEqual({ tool: "connections.post", provider: "slack", limits: { channels: "joined", maxPerRun: 10 } });
  });

  it("gives the Gmail tools only when canReadGmail is on and the owner has Gmail connected", () => {
    const GMAIL: AnyDraftToolPermission[] = [{ tool: "connections.list", provider: "gmail" }, { tool: "connections.search", provider: "gmail" }, { tool: "connections.read", provider: "gmail" }];
    expect(routinePermissions({ canReadGmail: true }, new Set(["gmail"]))).toEqual([...ROUTINE_PERMISSIONS, ...ROUTINE_TOOLS, ...GMAIL]);
    expect(routinePermissions({ canReadGmail: true }, new Set())).toEqual([...ROUTINE_PERMISSIONS, ...ROUTINE_TOOLS]);
    expect(routinePermissions({ canReadGmail: true })).toEqual([...ROUTINE_PERMISSIONS, ...ROUTINE_TOOLS]);
    expect(routinePermissions({ canReadGmail: false }, new Set(["gmail"]))).toEqual([...ROUTINE_PERMISSIONS, ...ROUTINE_TOOLS]);
    expect(routinePermissions({}, new Set(["gmail"]))).toEqual([...ROUTINE_PERMISSIONS, ...ROUTINE_TOOLS]);
    const spec = buildRoutineRunSpec({ ...input, routine: { ...input.routine, canReadGmail: true }, ownerConnectionProviders: new Set(["gmail"]) });
    expect(spec.permissions.map((permission) => permission.tool as string)).toContain("connections.search");
  });

  it("lets every routine run create up to 5 routines, and a routine's runs manage routines through the per-call guards", () => {
    expect(ROUTINE_CREATE_MAX_PER_RUN).toBe(5);
    expect(routinePermissions({})).toContainEqual({ tool: "routines.create", limits: { maxPerRun: ROUTINE_CREATE_MAX_PER_RUN } });
  });

  it("builds a routine spec with those permissions and the webhook trigger", () => {
    const spec = buildRoutineRunSpec({
      ...input,
      trigger: { type: "webhook", provider: "fireflies", eventId: "m-1" },
      routine: { ...input.routine, canNotify: true },
    });
    expect(spec.trigger).toEqual({ type: "webhook", provider: "fireflies", eventId: "m-1" });
    expect(spec.onBehalfOf as string).toBe(input.ownerUserId);
    expect(spec.permissions.map((permission) => permission.tool as string)).toContain("people.notify");
  });
});

describe("renderRoutinePrompt", () => {
  const context = { title: "Digest", setup: "Daily", timezone: "UTC", startedAt: new Date("2026-11-09T09:00:00Z"), startedBy: { type: "schedule" as const } };

  it("mentions Draft's tool server only when the run has one", () => {
    const withTools = renderRoutinePrompt("Go", { ...context, hasDraftTools: true });
    expect(withTools).toContain('"draft" tool server');
    expect(withTools).toContain("context.write");
    expect(withTools).toContain("baseSha");
    expect(withTools).toContain("call context.read");
    expect(renderRoutinePrompt("Go", context)).not.toContain("context.write");
    expect(renderRoutinePrompt("Go", context)).not.toContain("tool server");
  });
});
