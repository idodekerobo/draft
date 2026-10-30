import { describe, expect, it } from "bun:test";
import { createSandboxCallbackToken } from "../../sandbox/callback-token";
import { completeRoutineRunCallback } from "../../routines/complete-routine-callback";
import { routineHostMachineId, routineRunId } from "../../routines/config";
import { fakeClient, fakeDb, type FakeDb } from "./fake-client";

const SECRET = "callback-secret";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "ws-1";
const BUNDLE_HASH = "b".repeat(64);

function seed(overrides: Record<string, unknown> = {}): FakeDb {
  return fakeDb({
    sessions: [{
      id: SESSION_ID, workspace_id: WORKSPACE_ID, session_type: "routine", status: "starting", last_seq: 0,
      host_machine_id: routineHostMachineId(SESSION_ID), scheduled_task_id: "task-1", ...overrides,
    }],
    scheduled_tasks: [{ id: "task-1", workspace_id: WORKSPACE_ID, config_json: { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: null } }],
    errors: [],
  });
}

function post(result: unknown, runId = routineRunId(SESSION_ID)): Request {
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

const assistantLine = { file: "root.jsonl", offset: 0, raw: JSON.stringify({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "Here is the digest." }] } }) };

describe("completeRoutineRunCallback", () => {
  it("appends the prompt first, then the agent's lines, as the session's own host", async () => {
    const db = seed();
    const response = await completeRoutineRunCallback(post({ kind: "lines", lines: [assistantLine] }), SECRET, fakeClient(db));

    expect(response.status).toBe(204);
    const call = db.rpcCalls.find((c) => c.name === "append_session_events")!;
    expect(call.args.p_host_machine_id).toBe(routineHostMachineId(SESSION_ID));
    expect((call.args.p_events as Array<{ kind: string }>).map((e) => e.kind)).toEqual(["user_message", "assistant_text"]);
  });

  it("reads a Codex routine's lines as codex exec output, with the prompt first", async () => {
    const db = seed({ harness: "codex" });
    const answer = { file: "exec.jsonl", offset: 4, raw: JSON.stringify({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "Here is the digest." } }) };
    const response = await completeRoutineRunCallback(post({ kind: "lines", lines: [answer, assistantLine] }), SECRET, fakeClient(db));

    expect(response.status).toBe(204);
    const events = db.rpcCalls[0]!.args.p_events as Array<{ kind: string; payload: { text?: string } }>;
    expect(events.map((e) => e.kind)).toEqual(["user_message", "assistant_text"]);
    expect(events[0]!.payload.text).toBe("Summarize the week.");
  });

  it("names a Codex failure code in the session note", async () => {
    const db = seed({ status: "live", harness: "codex" });
    await completeRoutineRunCallback(post({ kind: "end", ok: false, error: "codex_exit" }), SECRET, fakeClient(db));
    expect(db.tables.errors).toHaveLength(1);
    expect(JSON.stringify(db.tables.errors![0])).toContain("codex_exit");
  });

  it("does not repeat the prompt once the session has events", async () => {
    const db = seed({ last_seq: 3 });
    await completeRoutineRunCallback(post({ kind: "lines", lines: [assistantLine] }), SECRET, fakeClient(db));
    const events = db.rpcCalls[0]!.args.p_events as Array<{ kind: string }>;
    expect(events.map((e) => e.kind)).toEqual(["assistant_text"]);
  });

  it("ends the session as completed when the run worked", async () => {
    const db = seed({ status: "live" });
    const response = await completeRoutineRunCallback(post({ kind: "end", ok: true }), SECRET, fakeClient(db));

    expect(response.status).toBe(204);
    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "completed" });
    expect(db.tables.errors).toHaveLength(0);
  });

  it("ends a failed run as failed with exactly one error row", async () => {
    const db = seed({ status: "live" });
    await completeRoutineRunCallback(post({ kind: "end", ok: false, error: "claude_error", diagnostics: { exit_code: 1 } }), SECRET, fakeClient(db));

    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ session_id: SESSION_ID, scheduled_task_id: "task-1", operation: "session" });
  });

  it("writes no second error when the failure arrives twice", async () => {
    const db = seed({ status: "live" });
    const client = fakeClient(db);
    await completeRoutineRunCallback(post({ kind: "end", ok: false, error: "timeout" }), SECRET, client);
    await completeRoutineRunCallback(post({ kind: "end", ok: false, error: "timeout" }), SECRET, client);
    expect(db.tables.errors).toHaveLength(1);
  });

  it("accepts a late batch for a session that already ended without appending", async () => {
    const db = seed({ status: "ended" });
    const response = await completeRoutineRunCallback(post({ kind: "lines", lines: [assistantLine] }), SECRET, fakeClient(db));
    expect(response.status).toBe(204);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("rejects a token for another run id and an interactive session", async () => {
    await expect(completeRoutineRunCallback(post({ kind: "end", ok: true }), "wrong-secret", fakeClient(seed()))).rejects.toThrow();
    const response = await completeRoutineRunCallback(post({ kind: "end", ok: true }), SECRET, fakeClient(seed({ session_type: "interactive" })));
    expect(response.status).toBe(404);
  });

  it("rejects a body that is neither lines nor an end message", async () => {
    const response = await completeRoutineRunCallback(post({ kind: "other" }), SECRET, fakeClient(seed()));
    expect(response.status).toBe(400);
  });
});
