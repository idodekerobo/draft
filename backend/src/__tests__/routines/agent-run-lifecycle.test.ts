import { describe, expect, it } from "bun:test";
import { finishAgentRun, markAgentRunRunning } from "../../metaharness/runs/lifecycle";
import { endRoutineSession, failRoutineSession } from "../../routines/fail-routine-session";
import { fakeClient, fakeDb } from "./fake-client";

const session = { id: "s1", workspace_id: "ws-1", scheduled_task_id: "t1", host_machine_id: "fly:s1" };

function setup(runStatus = "running") {
  const db = fakeDb({
    sessions: [{ ...session, status: "live", harness: "claude" }],
    agent_runs: [{ id: "r1", workspace_id: "ws-1", session_id: "s1", status: runStatus }],
    errors: [],
  });
  return { db, client: fakeClient(db), run: () => db.tables.agent_runs![0]! };
}

describe("a routine's agent run follows its session", () => {
  it("is succeeded when the session completes", async () => {
    const { client, run } = setup();
    await endRoutineSession(client, session, "completed");
    expect(run()).toMatchObject({ status: "succeeded", failure_code: null });
    expect(run().completed_at).toBeTruthy();
  });

  it("is failed, with the failure code and message, when the session fails", async () => {
    const { client, run } = setup();
    await failRoutineSession(client, session, { code: "routine_run_failed", note: "n", message: "Routine run failed: timeout" });
    expect(run()).toMatchObject({ status: "failed", failure_code: "routine_run_failed", failure_detail: "Routine run failed: timeout" });
  });

  it("is cancelled when the run was skipped on purpose", async () => {
    const { client, run } = setup();
    await failRoutineSession(client, session, { code: "routine_run_skipped", note: "n", message: "m", silent: true });
    expect(run()).toMatchObject({ status: "cancelled", failure_code: "routine_run_skipped" });
  });

  it("keeps its first outcome when the session end is reported twice", async () => {
    const { client, run } = setup();
    await endRoutineSession(client, session, "completed");
    await failRoutineSession(client, session, { code: "late", note: "n", message: "m" });
    expect(run()).toMatchObject({ status: "succeeded", failure_code: null });
  });

  it("does not touch a run that already finished", async () => {
    const { client, run } = setup("failed");
    await endRoutineSession(client, session, "completed");
    expect(run().status).toBe("failed");
  });

  it("leaves a session with no run record working as before", async () => {
    const db = fakeDb({ sessions: [{ ...session, status: "live", harness: "claude" }], agent_runs: [], errors: [] });
    expect(await endRoutineSession(fakeClient(db), session, "completed")).toBe(true);
    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "completed" });
  });
});

describe("agent run lifecycle helpers", () => {
  it("marks a run running with its machine and start time", async () => {
    const { client, run } = setup("preparing");
    await markAgentRunRunning(client, "r1", "machine-1");
    expect(run()).toMatchObject({ status: "running", sandbox_machine_id: "machine-1" });
    expect(run().started_at).toBeTruthy();
  });

  it("finishes a run once and ignores a second finish", async () => {
    const { client, run } = setup();
    await finishAgentRun(client, "r1", { status: "failed", failureCode: "x" });
    await finishAgentRun(client, "r1", { status: "succeeded" });
    expect(run()).toMatchObject({ status: "failed", failure_code: "x" });
  });

  it("does not throw when the database refuses the update", async () => {
    const failing = { from: () => ({ update: () => ({ eq: () => ({ in: async () => ({ error: new Error("db down") }) }) }) }) } as never;
    await expect(markAgentRunRunning(failing, "r1")).resolves.toBeUndefined();
    await expect(finishAgentRun(failing, "r1", { status: "failed" })).resolves.toBeUndefined();
  });
});
