import { describe, expect, it } from "bun:test";
import { cronTrigger } from "draft-core/run-spec";
import { buildBuiltInRunSpec } from "../../routines/built-in-run-spec";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const TASK = "55555555-5555-4555-8555-555555555555";
const VERSION = "44444444-4444-4444-8444-444444444444";
const base = { id: RUN, workspaceId: WS, trigger: cronTrigger(TASK, "2026-11-26T03:00:00.000Z"), contextVersionId: VERSION, resultSchema: { type: "object" } };

describe("the run spec every built-in routine shares", () => {
  it("runs on the default agent in a restricted sandbox, for the workspace, with a structured result", () => {
    const spec = buildBuiltInRunSpec({ ...base, kind: "summarization" });
    expect(spec).toMatchObject({ kind: "summarization", harness: "claude", model: null, reasoningEffort: null, instructions: "", permissions: [], onBehalfOf: null });
    expect(spec.execution).toEqual({ target: { type: "sandbox" }, adapterId: "claude-print" });
    expect(spec.computer).toEqual({ type: "sandbox", profileId: "default", workingDirectory: "/run", network: "restricted" });
    expect(spec.output).toEqual({ type: "structured", schema: { type: "object" } });
    expect(spec.inputs.contextVersionId as string).toBe(VERSION);
  });

  it("takes the team's settings and the permissions the routine needs", () => {
    const settings = { harness: "codex" as const, model: "gpt-6-luna", prompt: "Focus on decisions.", reasoningEffort: "high" };
    const spec = buildBuiltInRunSpec({ ...base, kind: "synthesis", settings, permissions: [{ tool: "context.read" }] });
    expect(spec).toMatchObject({ kind: "synthesis", harness: "codex", model: "gpt-6-luna", instructions: "Focus on decisions.", reasoningEffort: "high" });
    expect(spec.permissions as unknown).toEqual([{ tool: "context.read" }]);
    expect(spec.toolset.nativeTools.every((tool) => tool.harness === "codex")).toBe(true);
  });
});
