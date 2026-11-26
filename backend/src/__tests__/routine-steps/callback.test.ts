import { describe, expect, it } from "bun:test";
import { createSandboxCallbackToken } from "../../metaharness/sandbox/callback-token";
import { advanceWorkflow } from "../../routine-steps/advance";
import { completeStepRunCallback } from "../../routine-steps/complete-step-callback";
import { PARENT, SECRET, CONFIG, children, items, parentRow, setup, step, type Harness } from "./harness";

const BUNDLE_HASH = "b".repeat(64);

function post(runId: string, body: Record<string, unknown>): Request {
  const token = createSandboxCallbackToken({ runId, bundleHash: BUNDLE_HASH, expiresAt: Date.now() + 60_000, nonce: "n" }, SECRET);
  const text = JSON.stringify({ run_id: runId, bundle_hash: BUNDLE_HASH, ...body });
  return new Request("https://api.test/sandbox/callback", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), "idempotency-key": `draft:${runId}:${BUNDLE_HASH}`, "x-draft-run-id": runId, "x-draft-bundle-hash": BUNDLE_HASH },
    body: text,
  });
}

const callback = (h: Harness, runId: string, body: Record<string, unknown>) =>
  completeStepRunCallback(post(runId, body), CONFIG, h.client, { resolveWorkflow: () => h.workflow, launch: h.deps.launch });

async function started(options: Parameters<typeof setup>[0]) {
  const h = setup(options);
  await advanceWorkflow(h.deps, PARENT);
  return h;
}

const run = (h: Harness, id: string) => (h.db.tables.agent_runs ?? []).find((row) => row.id === id)!;

describe("a step run's callback", () => {
  it("saves the answer, the transcript and the usage, ends the run, and moves the parent on", async () => {
    const h = await started({ steps: [step("capture"), step("organize")], plans: { capture: () => items(1), organize: () => items(1) } });
    const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 0, costUsd: 0.01 };
    const response = await callback(h, h.launched[0]!, { result: { entries: [{ text: "x" }], summary: "one entry" }, transcript: [{ type: "result" }], usage });
    expect(response.status).toBe(204);
    expect(run(h, h.launched[0]!)).toMatchObject({ status: "succeeded", result_json: { entries: [{ text: "x" }], summary: "one entry" }, transcript_json: [{ type: "result" }], usage_json: usage, summary: "one entry" });
    expect(children(h, "organize")).toHaveLength(1);
    expect(h.launched).toHaveLength(2);
  });

  it("finishes the parent when the last step's last run reports", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    await callback(h, h.launched[0]!, { result: { done: true } });
    expect(parentRow(h).status).toBe("succeeded");
    expect(h.finished).toHaveLength(1);
  });

  it("records a runner's failure with its category, so a rate limit waits before the retry", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    await callback(h, h.launched[0]!, { result: { error: "claude_error", diagnostics: { failureCategory: "rate_limit" } } });
    expect(run(h, h.launched[0]!)).toMatchObject({ status: "failed", failure_code: "claude_error", failure_detail: "rate_limit" });
    // Not started again at once: the retry waits out its backoff.
    expect(children(h).find((row) => row.attempt === 2)!.status).toBe("queued");
    expect(h.launched).toHaveLength(1);
  });

  it("retries a failure that is not a rate limit at once", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    await callback(h, h.launched[0]!, { result: { error: "claude_exit", diagnostics: { failureCategory: "other" } } });
    expect(children(h).find((row) => row.attempt === 2)!.status).toBe("running");
  });

  it("fails a run whose answer is not a JSON object", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    await callback(h, h.launched[0]!, { result: "just some text" });
    expect(run(h, h.launched[0]!)).toMatchObject({ status: "failed", failure_code: "step_result_invalid" });
  });

  it("changes nothing for a run that had already ended", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    const runId = h.launched[0]!;
    await callback(h, runId, { result: { first: true } });
    const response = await callback(h, runId, { result: { second: true } });
    expect(response.status).toBe(204);
    expect(run(h, runId).result_json).toEqual({ first: true });
    expect(h.finished).toHaveLength(1);
  });

  it("answers 404 for a run that is not a step run, so the runner stops sending", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    expect((await callback(h, PARENT, { result: {} })).status).toBe(404);
    expect((await callback(h, "99999999-9999-4999-8999-999999999999", { result: {} })).status).toBe(404);
  });

  it("still answers 204 when moving the parent on fails, and records why", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    h.workflow.finish = async () => { throw new Error("database blip"); };
    const response = await callback(h, h.launched[0]!, { result: { ok: true } });
    expect(response.status).toBe(204);
    expect(run(h, h.launched[0]!).status).toBe("succeeded");
    expect(h.db.tables.errors!.map((row) => row.message)).toContain("Moving a routine run on after a step run ended failed");
  });

  it("never asks a person for input: a step's needs_input is saved as its answer and nothing acts on it", async () => {
    const h = await started({ steps: [step("capture"), step("organize")], plans: { capture: () => items(1), organize: () => items(1) }, extraTables: { agent_run_input_requests: [] } });
    const needsInput = [{ question: "Which is right?", current_claim: "a", new_claim: "b", reason: "r", evidence: [] }];
    await callback(h, h.launched[0]!, { result: { entries: [], needs_input: needsInput } });
    expect(h.db.tables.agent_run_input_requests).toEqual([]);
    expect(parentRow(h).needs_input_json).toBeUndefined();
    expect(run(h, h.launched[0]!).needs_input_json).toBeUndefined();
  });

  it("rejects a callback that is not signed for the run", async () => {
    const h = await started({ steps: [step("capture")], plans: { capture: () => items(1) } });
    const forged = new Request("https://api.test/sandbox/callback", { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json", "x-draft-run-id": h.launched[0]! }, body: "{}" });
    await expect(completeStepRunCallback(forged, CONFIG, h.client, { resolveWorkflow: () => h.workflow })).rejects.toThrow();
    expect(run(h, h.launched[0]!).status).toBe("running");
  });
});
