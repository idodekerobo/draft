import { describe, expect, it } from "bun:test";
import { saveAgentRunSpec, specFromRow } from "../../metaharness/runs/agent-run-store";
import { CONTEXT_READ_WRITE_PERMISSIONS } from "draft-core/agent-run";
import { buildSynthesisRunSpec, synthesisTrigger } from "../../synthesis/run-spec";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "22222222-2222-4222-8222-222222222222";
const RUN = "11111111-1111-4111-8111-111111111111";
const TASK = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const VERSION = "44444444-4444-4444-8444-444444444444";
const WHEN = "2026-11-09T03:00:00.000Z";

describe("how a synthesis run started", () => {
  it("a scheduled run is a cron trigger with its occurrence", () => {
    expect(synthesisTrigger({ triggerType: "schedule", scheduledTaskId: TASK, occurrenceAt: WHEN }) as unknown).toEqual({ type: "cron", scheduledTaskId: TASK, occurrenceAt: WHEN });
  });

  it("a retry names the run it retries", () => {
    expect(synthesisTrigger({ triggerType: "retry", retryOfRunId: OTHER }) as unknown).toEqual({ type: "retry", retryOf: OTHER });
  });

  it("any other trigger is a system trigger with its own name as the reason", () => {
    expect(synthesisTrigger({ triggerType: "manual" }) as unknown).toEqual({ type: "system", reason: "manual" });
    expect(synthesisTrigger({ triggerType: "source_threshold" }) as unknown).toEqual({ type: "system", reason: "source_threshold" });
    expect(synthesisTrigger({ triggerType: "stale_requeue" }) as unknown).toEqual({ type: "system", reason: "stale_requeue" });
  });

  it("a scheduled run with no task, which the scheduler never makes, falls back to manual", () => {
    expect(synthesisTrigger({ triggerType: "schedule" }) as unknown).toEqual({ type: "system", reason: "manual" });
  });
});

describe("the synthesis run spec", () => {
  const spec = buildSynthesisRunSpec({
    runId: RUN, workspaceId: WS, triggerType: "manual", contextVersionId: VERSION, resultSchema: { type: "object" }, permissions: CONTEXT_READ_WRITE_PERMISSIONS,
  });

  it("may read and write context, with Read and Glob in the sandbox, and returns a structured result", () => {
    expect(spec.kind).toBe("synthesis");
    expect(spec.permissions as unknown).toEqual([{ tool: "context.read" }, { tool: "context.write" }]);
    expect(spec.output).toEqual({ type: "structured", schema: { type: "object" } });
    expect(spec.inputs.contextVersionId as string).toBe(VERSION);
  });

  it("is saved onto the run row a trigger already made, and reads back the same", async () => {
    const db = fakeDb({
      agent_runs: [{
        id: RUN, workspace_id: WS, kind: "synthesis", trigger: { type: "system", reason: "manual" }, principal: { type: "workspace" },
        runtime: { type: "cloud", environment: { nativeTools: [], mcpServers: [], skills: [], instructions: [] } },
        harness: "claude", model: null, instructions: "", base_context_version_id: VERSION, permissions: [], output: { type: "none" }, status: "preparing",
      }],
    });
    await saveAgentRunSpec(fakeClient(db), spec);
    expect(specFromRow(db.tables.agent_runs![0] as never) as unknown).toEqual(spec);
  });
});
