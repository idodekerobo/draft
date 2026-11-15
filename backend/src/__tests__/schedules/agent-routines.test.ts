import { beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

let db: FakeDb;
mock.module("../../db/client", () => ({ serviceClient: { from: (t: string) => fakeClient(db).from(t), rpc: () => ({}) } }));

const { createAgentRoutine, getRoutineTask, listRoutineRuns, listConnectedProviders, listRoutines, updateRoutine } = await import("../../schedules/service");

const config = { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude" as const, model: null };

beforeEach(() => {
  db = fakeDb({ scheduled_tasks: [], sessions: [], users: [], source_connections: [] });
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

  it("keeps a routine whose schedule is off from ever coming due, and turns the schedule back on", async () => {
    const now = new Date("2026-10-27T10:00:00.000Z");
    const triggered = { ...config, onSchedule: false as const, events: ["fireflies.meeting_summarized" as const] };
    const routine = await createAgentRoutine("ws-1", "user-1", { config: triggered, schedule: { preset: "daily", time: "09:00", timezone: "UTC" } }, now);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({ enabled: true, next_due_at: null });
    expect(routine.scheduleDescription).toBe("When a Fireflies meeting is summarized");

    const task = (await getRoutineTask("ws-1", routine.id))!;
    await updateRoutine(task, { agent: { ...config } }, "user-1", now);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({ next_due_at: "2026-10-28T09:00:00.000Z" });
  });

  it("lists the providers the workspace has a live connection to", async () => {
    expect(await listConnectedProviders("ws-1")).toEqual([]);
    db.tables.source_connections!.push(
      { id: "c1", workspace_id: "ws-1", provider: "slack", status: "active" },
      { id: "c2", workspace_id: "ws-1", provider: "github", status: "degraded" },
      { id: "c3", workspace_id: "ws-1", provider: "linear", status: "revoked" },
      { id: "c4", workspace_id: "ws-2", provider: "granola", status: "active" },
    );
    expect(await listConnectedProviders("ws-1")).toEqual(["github", "slack"]);
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
    expect(runs!.runs.map((r) => [r.id, r.status])).toEqual([["c", "running"], ["b", "failed"], ["a", "completed"]]);
    expect(runs!.nextCursor).toBeNull();
    const one = await listRoutineRuns("ws-1", taskId, { runId: "a" });
    expect(one!.runs.map((r) => r.id)).toEqual(["a"]);
  });

  it("says what started each run, read from its idempotency key", async () => {
    await createAgentRoutine("ws-1", "user-1", { config, schedule: { preset: "hourly" } });
    const taskId = db.tables.scheduled_tasks![0]!.id as string;
    const run = (id: string, startedAt: string, key: string) => ({ id, workspace_id: "ws-1", scheduled_task_id: taskId, status: "ended", end_reason: "completed", started_at: startedAt, ended_at: null, idempotency_key: key });
    db.tables.sessions!.push(
      run("a", "2026-10-27T08:00:00.000Z", `${taskId}:2026-10-27T08:00:00.000Z`),
      run("b", "2026-10-27T09:00:00.000Z", `${taskId}:manual:99999999-9999-4999-8999-999999999999`),
      run("c", "2026-10-27T10:00:00.000Z", `${taskId}:github.pull_request_merged:acme/app#7`),
    );
    const runs = await listRoutineRuns("ws-1", taskId);
    expect(runs!.runs.map((r) => [r.id, r.startedBy])).toEqual([
      ["c", { type: "event", event: "github.pull_request_merged" }],
      ["b", { type: "run_now" }],
      ["a", { type: "schedule" }],
    ]);
  });

  it("names connections a routine needs that the workspace no longer has", async () => {
    await createAgentRoutine("ws-1", "user-1", { config: { ...config, events: ["linear.issue_created"], canNotify: true }, schedule: { preset: "hourly" } });
    db.tables.source_connections!.push({ workspace_id: "ws-1", provider: "slack", status: "active" });
    const [routine] = await listRoutines("ws-1");
    expect(routine!.agent!.missingConnections).toEqual(["linear"]);
  });

  it("returns null for a routine that is not in the workspace", async () => {
    expect(await listRoutineRuns("ws-1", "missing")).toBeNull();
  });
});
