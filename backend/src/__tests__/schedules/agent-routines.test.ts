import { beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

let db: FakeDb;
mock.module("../../db/client", () => ({ serviceClient: { from: (t: string) => fakeClient(db).from(t), rpc: () => ({}) } }));

const { createAgentRoutine, listRoutineRuns, listRoutines } = await import("../../schedules/service");

const config = { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude" as const, model: null };

beforeEach(() => {
  db = fakeDb({ scheduled_tasks: [], sessions: [], users: [] });
});

describe("agent routines", () => {
  it("creates a routine owned by its creator, due at its next scheduled time", async () => {
    const routine = await createAgentRoutine("ws-1", "user-1", { config, schedule: { preset: "daily", time: "09:00", timezone: "UTC" } }, new Date("2026-10-27T10:00:00.000Z"));

    expect(db.tables.scheduled_tasks).toHaveLength(1);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({
      task_type: "agent_routine", created_by_user_id: "user-1", enabled: true, cron_expression: "0 9 * * *", next_due_at: "2026-10-28T09:00:00.000Z",
    });
    expect(routine).toMatchObject({ taskType: "agent_routine", title: "Weekly digest", scheduleDescription: "Daily at 9:00 AM", agent: { prompt: "Summarize the week.", lastRun: null } });
  });

  it("rejects a schedule it cannot build", async () => {
    await expect(createAgentRoutine("ws-1", "user-1", { config, schedule: { preset: "daily", time: "9am" } })).rejects.toThrow();
    expect(db.tables.scheduled_tasks).toHaveLength(0);
  });

  it("lists a routine with the state of its newest run", async () => {
    await createAgentRoutine("ws-1", "user-1", { config, schedule: { preset: "hourly" } });
    const taskId = db.tables.scheduled_tasks![0]!.id as string;
    db.tables.sessions!.push(
      { id: "s-old", workspace_id: "ws-1", scheduled_task_id: taskId, status: "ended", end_reason: "completed", started_at: "2026-10-27T08:00:00.000Z", ended_at: "2026-10-27T08:02:00.000Z" },
      { id: "s-new", workspace_id: "ws-1", scheduled_task_id: taskId, status: "live", end_reason: null, started_at: "2026-10-27T09:00:00.000Z", ended_at: null },
    );

    const routines = await listRoutines("ws-1");
    expect(routines[0]!.agent!.lastRun).toMatchObject({ id: "s-new", status: "running" });
  });

  it("lists run history newest first with completed, failed and running states", async () => {
    await createAgentRoutine("ws-1", "user-1", { config, schedule: { preset: "hourly" } });
    const taskId = db.tables.scheduled_tasks![0]!.id as string;
    const run = (id: string, startedAt: string, status: string, endReason: string | null) => ({ id, workspace_id: "ws-1", scheduled_task_id: taskId, status, end_reason: endReason, started_at: startedAt, ended_at: null });
    db.tables.sessions!.push(
      run("a", "2026-10-27T08:00:00.000Z", "ended", "completed"),
      run("b", "2026-10-27T09:00:00.000Z", "ended", "failed"),
      run("c", "2026-10-27T10:00:00.000Z", "starting", null),
    );

    const runs = await listRoutineRuns("ws-1", taskId);
    expect(runs!.map((r) => [r.id, r.status])).toEqual([["c", "running"], ["b", "failed"], ["a", "completed"]]);
  });

  it("returns null for a routine that is not in the workspace", async () => {
    expect(await listRoutineRuns("ws-1", "missing")).toBeNull();
  });
});
