import { describe, expect, it } from "bun:test";
import { createSandboxCallbackToken } from "../../sandbox/callback-token";
import {
  completeSummarizationRunCallback,
  parseAgentRunIdFromSummarizationRunId,
} from "../../summarization/complete-summarization-callback";
import { startSummarizationRun } from "../../summarization/run-summarization-batch";
import { summarizationJsonSchema } from "../../summarization/render-prompt";
import { buildSummarizationRunSpec } from "../../summarization/run-spec";
import { fakeClient, fakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const TASK = "55555555-5555-4555-8555-555555555555";
const VERSION = "44444444-4444-4444-8444-444444444444";
const RUN = "22222222-2222-4222-8222-222222222222";
const SECRET = "callback-secret";
const BUNDLE_HASH = "b".repeat(64);

const schedule = { scheduledTaskId: TASK, occurrenceAt: "2026-11-09T03:00:00.000Z" };

function newDb() {
  return fakeDb({
    workspaces: [{ id: WS, timezone: "UTC", current_context_version_id: VERSION }],
    workspace_context_versions: [{ id: VERSION, version_number: 1, documents_json: {} }],
    agent_runs: [],
    agent_sessions: [
      { id: "s1", workspace_id: WS, summary_status: "leased", summary_agent_run_id: null },
      { id: "s2", workspace_id: WS, summary_status: "leased", summary_agent_run_id: null },
      { id: "other", workspace_id: WS, summary_status: "pending", summary_agent_run_id: null },
    ],
    errors: [],
  });
}

describe("summarization run spec", () => {
  it("is a cloud batch of the claimed sessions with no Draft tools, started by the schedule", () => {
    const spec = buildSummarizationRunSpec({ id: RUN, workspaceId: WS, scheduledTaskId: TASK, occurrenceAt: schedule.occurrenceAt, contextVersionId: VERSION, resultSchema: summarizationJsonSchema() });
    expect(spec).toMatchObject({
      kind: "summarization",
      harness: "claude",
      permissions: [],
      actor: { type: "agent", runId: RUN }, onBehalfOf: null,
      trigger: { type: "cron", scheduledTaskId: TASK, occurrenceAt: schedule.occurrenceAt },
      output: { type: "structured" },
    });
    expect(spec.runtime.type).toBe("cloud");
  });
});

describe("startSummarizationRun", () => {
  it("creates a preparing run and links exactly the sessions it claimed to it", async () => {
    const db = newDb();
    const { agentRunId: runId } = await startSummarizationRun({ workspaceId: WS, schedule, client: fakeClient(db) }, ["s1", "s2"], summarizationJsonSchema());

    expect(db.tables.agent_runs).toHaveLength(1);
    expect(db.tables.agent_runs![0]).toMatchObject({ id: runId, kind: "summarization", status: "preparing", workspace_id: WS, base_context_version_id: VERSION });
    const linked = db.tables.agent_sessions!.filter((session) => session.summary_agent_run_id === runId).map((session) => session.id);
    expect(linked).toEqual(["s1", "s2"]);
    expect(db.tables.agent_sessions!.find((session) => session.id === "other")!.summary_agent_run_id).toBeNull();
  });
});

// The id a batch reported under before kind routing. Still accepted for a batch that started before the change.
const summarizationRunId = (workspaceId: string, agentRunId: string): string => `summarize:${workspaceId}:${agentRunId}`;

describe("summarization run ids", () => {
  it("carry the workspace and the agent run, and the run is recovered from them", () => {
    const id = summarizationRunId(WS, RUN);
    expect(id).toBe(`summarize:${WS}:${RUN}`);
    expect(parseAgentRunIdFromSummarizationRunId(id)).toBe(RUN);
  });

  it("give no run for an id that does not end in one", () => {
    expect(parseAgentRunIdFromSummarizationRunId("summarize:workspace-1:not-a-uuid")).toBeNull();
    expect(parseAgentRunIdFromSummarizationRunId("55555555-5555-4555-8555-555555555555")).toBeNull();
  });
});

function post(result: unknown, runId: string): Request {
  const token = createSandboxCallbackToken({ runId, bundleHash: BUNDLE_HASH, expiresAt: Date.now() + 60_000, nonce: "n" }, SECRET);
  const body = JSON.stringify({ run_id: runId, bundle_hash: BUNDLE_HASH, result });
  return new Request("https://api.test/sandbox/callback", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(body)),
      "idempotency-key": `draft:${runId}:${BUNDLE_HASH}`,
      "x-draft-run-id": runId,
      "x-draft-bundle-hash": BUNDLE_HASH,
    },
    body,
  });
}

describe("the summarization callback ends the agent run", () => {
  const runningDb = () => {
    const db = newDb();
    db.tables.agent_runs!.push({ id: RUN, workspace_id: WS, kind: "summarization", status: "running" });
    return db;
  };

  it("succeeds with a count when the runner reports its results", async () => {
    const db = runningDb();
    const response = await completeSummarizationRunCallback(post({ items: [] }, summarizationRunId(WS, RUN)), SECRET, fakeClient(db));
    expect(response.status).toBe(204);
    expect(db.tables.agent_runs![0]).toMatchObject({ status: "succeeded", summary: "0 of 0 sessions summarized", failure_code: null });
    expect(db.tables.agent_runs![0]!.completed_at).toBeTruthy();
  });

  it("finishes a batch that reports under the agent run's own id", async () => {
    const db = runningDb();
    const response = await completeSummarizationRunCallback(post({ items: [] }, RUN), SECRET, fakeClient(db));
    expect(response.status).toBe(204);
    expect(db.tables.agent_runs![0]).toMatchObject({ status: "succeeded", summary: "0 of 0 sessions summarized" });
  });

  it("fails with the runner's own reason when the runner reports a setup failure", async () => {
    const db = runningDb();
    await completeSummarizationRunCallback(post({ error: "bundle_fetch_failed", diagnostics: {} }, summarizationRunId(WS, RUN)), SECRET, fakeClient(db));
    expect(db.tables.agent_runs![0]).toMatchObject({ status: "failed", failure_code: "summarization_runner_failed", failure_detail: "bundle_fetch_failed" });
  });

  it("fails with the stage when the result is not valid, and still raises the error", async () => {
    const db = runningDb();
    const originalError = console.error;
    console.error = () => undefined;
    try {
      await expect(completeSummarizationRunCallback(post({ nonsense: true }, summarizationRunId(WS, RUN)), SECRET, fakeClient(db))).rejects.toThrow();
    } finally {
      console.error = originalError;
    }
    expect(db.tables.agent_runs![0]).toMatchObject({ status: "failed", failure_code: "summarization_validation_failed" });
  });

  it("changes nothing for a batch that has no run record, as before", async () => {
    const db = runningDb();
    const response = await completeSummarizationRunCallback(post({ items: [] }, `summarize:${WS}:99999999-9999-4999-8999-999999999999`), SECRET, fakeClient(db));
    expect(response.status).toBe(204);
    expect(db.tables.agent_runs![0]!.status).toBe("running");
  });
});
