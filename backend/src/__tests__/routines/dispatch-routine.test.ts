import { describe, expect, it, mock } from "bun:test";
import { dispatchAgentRoutine } from "../../routines/dispatch-routine";
import { failStaleRoutineSessions } from "../../routines/fail-stale-routine-sessions";
import type { LaunchRoutineRun } from "../../routines/launch-routine-run";
import type { ScheduledTaskRow } from "../../types/tables";
import { fakeClient, fakeDb } from "./fake-client";

const task = {
  id: "task-1",
  workspace_id: "ws-1",
  task_type: "agent_routine",
  created_by_user_id: "user-1",
  config_json: { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude", model: "haiku" },
} as unknown as ScheduledTaskRow;

const newDb = () => fakeDb({ sessions: [], errors: [] }, { unique: { sessions: [["workspace_id", "idempotency_key"]] } });
const sandboxConfig = {} as never;
const okLaunch = () => mock<LaunchRoutineRun>(async () => ({ machineId: "machine-1" }));

function dispatch(db: ReturnType<typeof newDb>, launch: LaunchRoutineRun, occurrenceAt = "2026-10-27T09:00:00.000Z", overrides: Partial<ScheduledTaskRow> = {}) {
  return dispatchAgentRoutine({ task: { ...task, ...overrides }, occurrenceAt, config: sandboxConfig, client: fakeClient(db), launch });
}

describe("dispatchAgentRoutine", () => {
  it("starts a session owned by the routine's creator and launches one run", async () => {
    const db = newDb();
    const launch = okLaunch();
    await dispatch(db, launch);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(db.tables.sessions).toHaveLength(1);
    expect(db.tables.sessions![0]).toMatchObject({
      session_type: "routine",
      owner_user_id: "user-1",
      scheduled_task_id: "task-1",
      status: "starting",
      title: "Weekly digest",
      model: "haiku",
      idempotency_key: "task-1:2026-10-27T09:00:00.000Z",
    });
    expect(db.tables.sessions![0]!.host_machine_id).toBe(`fly:${db.tables.sessions![0]!.id}`);
  });

  it("dispatches a duplicate occurrence once", async () => {
    const db = newDb();
    const launch = okLaunch();
    await dispatch(db, launch);
    db.tables.sessions![0]!.status = "ended";
    await dispatch(db, launch);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(db.tables.sessions).toHaveLength(1);
  });

  it("skips while the previous run is still going, and does not catch up", async () => {
    const db = newDb();
    const launch = okLaunch();
    await dispatch(db, launch, "2026-10-27T09:00:00.000Z");
    await dispatch(db, launch, "2026-10-27T10:00:00.000Z");

    expect(launch).toHaveBeenCalledTimes(1);
    expect(db.tables.sessions).toHaveLength(1);
  });

  it("runs the next occurrence once the previous run has ended", async () => {
    const db = newDb();
    const launch = okLaunch();
    await dispatch(db, launch, "2026-10-27T09:00:00.000Z");
    db.tables.sessions![0]!.status = "ended";
    await dispatch(db, launch, "2026-10-27T10:00:00.000Z");

    expect(launch).toHaveBeenCalledTimes(2);
    expect(db.tables.sessions).toHaveLength(2);
  });

  it("ends a run that cannot start as failed with one error and no retry", async () => {
    const db = newDb();
    const launch = mock<LaunchRoutineRun>(async () => { throw new Error("fly is down"); });
    await dispatch(db, launch);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(db.tables.sessions![0]).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ operation: "session", scheduled_task_id: "task-1", session_id: db.tables.sessions![0]!.id });
  });

  it("throws for a routine with no creator or an invalid config, without starting a session", async () => {
    const db = newDb();
    await expect(dispatch(db, okLaunch(), undefined, { created_by_user_id: null })).rejects.toThrow("no creator");
    await expect(dispatch(db, okLaunch(), undefined, { config_json: { title: "x" } })).rejects.toThrow("invalid config");
    expect(db.tables.sessions).toHaveLength(0);
  });
});

describe("failStaleRoutineSessions", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  const session = (id: string, startedAt: string, extra: Record<string, unknown> = {}) => ({
    id, workspace_id: "ws-1", session_type: "routine", status: "starting", scheduled_task_id: "task-1",
    host_machine_id: `fly:${id}`, started_at: startedAt, ...extra,
  });

  it("fails a silent machine once it is past the timeout, and leaves a fresh run alone", async () => {
    const db = fakeDb({
      sessions: [session("old", "2026-10-27T11:30:00.000Z"), session("fresh", "2026-10-27T11:55:00.000Z")],
      errors: [],
    });
    expect(await failStaleRoutineSessions(fakeClient(db), now)).toBe(1);

    expect(db.tables.sessions!.find((s) => s.id === "old")).toMatchObject({ status: "ended", end_reason: "failed" });
    expect(db.tables.sessions!.find((s) => s.id === "fresh")!.status).toBe("starting");
    expect(db.tables.errors).toHaveLength(1);
  });

  it("writes no second error on the next tick", async () => {
    const db = fakeDb({ sessions: [session("old", "2026-10-27T11:30:00.000Z", { status: "live" })], errors: [] });
    await failStaleRoutineSessions(fakeClient(db), now);
    await failStaleRoutineSessions(fakeClient(db), now);
    expect(db.tables.errors).toHaveLength(1);
  });

  it("never touches interactive sessions", async () => {
    const db = fakeDb({ sessions: [session("mine", "2026-10-27T08:00:00.000Z", { session_type: "interactive" })], errors: [] });
    expect(await failStaleRoutineSessions(fakeClient(db), now)).toBe(0);
  });
});
