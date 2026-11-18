import { beforeEach, describe, expect, it, mock } from "bun:test";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";
import { personCreator } from "../../routines/creator";

let db: FakeDb;
mock.module("../../db/client", () => ({ serviceClient: { from: (t: string) => fakeClient(db).from(t), rpc: () => ({}) } }));

const { createAgentRoutine, getRoutineTask, listRoutineRuns, listConnectedProviders, listRoutines, updateRoutine } = await import("../../routines/service");

const config = { title: "Weekly digest", prompt: "Summarize the week.", harness: "claude" as const, model: null };
const daily = { schedule: { preset: "daily" as const, time: "09:00", timezone: "UTC" } };
const NOW = new Date("2026-10-27T10:00:00.000Z");
const ONCE_NOW = new Date("2026-11-16T12:00:00.000Z");
const creator = personCreator("user-1", "app");

beforeEach(() => {
  db = fakeDb({ scheduled_tasks: [], sessions: [], users: [], source_connections: [] });
});

describe("agent routines", () => {
  it("creates a routine owned by its creator, due at its next scheduled time", async () => {
    const routine = await createAgentRoutine("ws-1", creator, { config, when: daily }, NOW);

    expect(db.tables.scheduled_tasks).toHaveLength(1);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({
      task_type: "agent_routine",
      created_by_user_id: "user-1",
      updated_by_user_id: "user-1",
      created_via: "app",
      created_by_run_id: null,
      trigger_depth: 0,
      visibility: "shared",
      enabled: true,
      cron_expression: "0 9 * * *",
      next_due_at: "2026-10-28T09:00:00.000Z",
    });
    expect(routine).toMatchObject({ taskType: "agent_routine", kind: "recurring", title: "Weekly digest", scheduleDescription: "Daily at 9:00 AM", agent: { prompt: "Summarize the week.", lastRun: null } });
  });

  it("records who made the routine, through which surface, and whether an agent made it", async () => {
    const routine = await createAgentRoutine("ws-1", { ...personCreator("user-1", "mcp") }, { config, when: daily }, NOW);
    expect(routine).toMatchObject({ createdVia: "mcp", madeByAgent: true, createdByRunId: null, visibility: "shared" });
  });

  it("keeps a routine whose schedule is off from ever coming due, and turns the schedule back on", async () => {
    const triggered = { ...config, onSchedule: false as const, events: ["fireflies.meeting_summarized" as const] };
    const routine = await createAgentRoutine("ws-1", creator, { config: triggered, when: { schedule: null, events: ["fireflies.meeting_summarized"] } }, NOW);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({ enabled: true, next_due_at: null, cron_expression: "0 9 * * *" });
    expect(routine).toMatchObject({ kind: "event", scheduleDescription: "When a Fireflies meeting is summarized" });

    const task = (await getRoutineTask("ws-1", routine.id))!;
    await updateRoutine(task, { agent: { ...config } }, "user-1", NOW);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({ next_due_at: "2026-10-28T09:00:00.000Z" });
  });

  it("turns the schedule off and on with when, and sets the triggers it names", async () => {
    const routine = await createAgentRoutine("ws-1", creator, { config, when: daily }, NOW);
    const off = await updateRoutine((await getRoutineTask("ws-1", routine.id))!, { when: { schedule: null } }, "user-1", NOW);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({ next_due_at: null, config_json: { onSchedule: false } });
    expect(off).toMatchObject({ kind: "event" });

    const on = await updateRoutine((await getRoutineTask("ws-1", routine.id))!, { when: { schedule: { preset: "daily", time: "09:00", timezone: "UTC" }, events: ["github.push"] } }, "user-1", NOW);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({ next_due_at: "2026-10-28T09:00:00.000Z", config_json: { events: ["github.push"] } });
    expect(db.tables.scheduled_tasks![0]!.config_json).not.toHaveProperty("onSchedule");
    expect(on).toMatchObject({ kind: "recurring" });
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

  it("rejects a schedule it cannot build, and names the field", async () => {
    await expect(createAgentRoutine("ws-1", creator, { config, when: { schedule: { preset: "daily", time: "9am" } } })).rejects.toMatchObject({
      code: "invalid_schedule",
      field: "time",
    });
    expect(db.tables.scheduled_tasks).toHaveLength(0);
  });

  it("lists a routine with the state of its newest run", async () => {
    await createAgentRoutine("ws-1", creator, { config, when: { schedule: { preset: "hourly" } } });
    const taskId = db.tables.scheduled_tasks![0]!.id as string;
    db.tables.sessions!.push(
      { id: "s-old", workspace_id: "ws-1", scheduled_task_id: taskId, status: "ended", end_reason: "completed", started_at: "2026-10-27T08:00:00.000Z", ended_at: "2026-10-27T08:02:00.000Z" },
      { id: "s-new", workspace_id: "ws-1", scheduled_task_id: taskId, status: "live", end_reason: null, started_at: "2026-10-27T09:00:00.000Z", ended_at: null },
    );

    const routines = await listRoutines("ws-1");
    expect(routines[0]!.agent!.lastRun).toMatchObject({ id: "s-new", status: "running" });
  });

  it("lists run history newest first with completed, failed and running states", async () => {
    await createAgentRoutine("ws-1", creator, { config, when: { schedule: { preset: "hourly" } } });
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
    const one = await listRoutineRuns("ws-1", taskId, { sessionId: "a" });
    expect(one!.runs.map((r) => r.id)).toEqual(["a"]);
  });

  it("says what started each run, read from its idempotency key", async () => {
    await createAgentRoutine("ws-1", creator, { config, when: { schedule: { preset: "hourly" } } });
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
      ["b", { type: "manual" }],
      ["a", { type: "schedule" }],
    ]);
  });

  it("names connections a routine needs that the workspace no longer has", async () => {
    await createAgentRoutine("ws-1", creator, {
      config: { ...config, events: ["linear.issue_created"], canNotify: true },
      when: { schedule: { preset: "hourly" }, events: ["linear.issue_created"] },
    });
    db.tables.source_connections!.push({ workspace_id: "ws-1", provider: "slack", status: "active" });
    const [routine] = await listRoutines("ws-1");
    expect(routine!.agent!.missingConnections).toEqual(["linear"]);
  });

  it("returns null for a routine that is not in the workspace", async () => {
    expect(await listRoutineRuns("ws-1", "missing")).toBeNull();
  });

  it("has no cap on how many routines a workspace can make", async () => {
    for (let index = 0; index < 21; index += 1) {
      await createAgentRoutine("ws-1", creator, { config, when: { schedule: { preset: "hourly" } } });
    }
    expect(db.tables.scheduled_tasks).toHaveLength(21);
  });

  it("records a failed insert, then refuses with the database error", async () => {
    db = fakeDb(
      { scheduled_tasks: [{ id: "existing", workspace_id: "ws-1", task_type: "agent_routine" }], errors: [] },
      { unique: { scheduled_tasks: [{ name: "one_per_workspace_test", columns: ["workspace_id"] }] } },
    );
    await expect(createAgentRoutine("ws-1", creator, { config, when: daily }, NOW)).rejects.toMatchObject({ code: "23505" });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ workspace_id: "ws-1", operation: "commit" });
    expect(db.tables.errors![0]!.detail_json).toMatchObject({ code: "routine_create_failed" });
  });
});

describe("once routines", () => {
  it("creates a once due at its time, with no cron and no interval", async () => {
    const routine = await createAgentRoutine("ws-1", creator, { config, when: { in: "2h" } }, ONCE_NOW);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({
      schedule_kind: "once",
      run_at: "2026-11-16T14:00:00.000Z",
      next_due_at: "2026-11-16T14:00:00.000Z",
      cron_expression: null,
      interval_seconds: null,
      timezone: "UTC",
      enabled: true,
    });
    expect(routine).toMatchObject({ kind: "once", runAt: "2026-11-16T14:00:00.000Z", firedAt: null, scheduleDescription: "Once at Nov 16, 2026 at 2:00 PM UTC" });
  });

  it("creates a disabled once with nothing due", async () => {
    await createAgentRoutine("ws-1", creator, { config, when: { at: "2026-11-20T10:00:00-05:00" }, enabled: false }, ONCE_NOW);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({ run_at: "2026-11-20T15:00:00.000Z", next_due_at: null, enabled: false });
  });

  it("refuses a once more than 365 days ahead, and creates nothing", async () => {
    await expect(createAgentRoutine("ws-1", creator, { config, when: { at: "2028-01-01T00:00:00.000Z" } }, ONCE_NOW)).rejects.toMatchObject({
      code: "too_far_ahead",
      field: "at",
    });
    expect(db.tables.scheduled_tasks).toHaveLength(0);
  });

  it("re-arms a fired once with a new time", async () => {
    const routine = await createAgentRoutine("ws-1", creator, { config, when: { in: "2h" } }, ONCE_NOW);
    Object.assign(db.tables.scheduled_tasks![0]!, { fired_at: "2026-11-16T14:00:00.000Z", enabled: false, next_due_at: null });

    const rearmed = await updateRoutine((await getRoutineTask("ws-1", routine.id))!, { when: { in: "1d" } }, "user-1", ONCE_NOW);
    expect(db.tables.scheduled_tasks![0]).toMatchObject({ run_at: "2026-11-17T12:00:00.000Z", fired_at: null, enabled: true, next_due_at: "2026-11-17T12:00:00.000Z" });
    expect(rearmed).toMatchObject({ kind: "once", firedAt: null, enabled: true });
  });

  it("refuses to turn a fired once back on without a new time", async () => {
    const routine = await createAgentRoutine("ws-1", creator, { config, when: { in: "2h" } }, ONCE_NOW);
    Object.assign(db.tables.scheduled_tasks![0]!, { fired_at: "2026-11-16T14:00:00.000Z", enabled: false, next_due_at: null });

    await expect(updateRoutine((await getRoutineTask("ws-1", routine.id))!, { enabled: true }, "user-1", ONCE_NOW)).rejects.toMatchObject({ code: "invalid_schedule", field: "when" });
  });

  it("refuses to change a once into a repeating routine, and the other way round", async () => {
    const once = await createAgentRoutine("ws-1", creator, { config, when: { in: "2h" } }, ONCE_NOW);
    await expect(updateRoutine((await getRoutineTask("ws-1", once.id))!, { when: daily }, "user-1", ONCE_NOW)).rejects.toMatchObject({
      code: "invalid_schedule",
      field: "when",
      message: "A routine can't change between once and repeating.",
    });

    const repeating = await createAgentRoutine("ws-1", creator, { config, when: daily }, ONCE_NOW);
    await expect(updateRoutine((await getRoutineTask("ws-1", repeating.id))!, { when: { in: "1h" } }, "user-1", ONCE_NOW)).rejects.toMatchObject({
      code: "invalid_schedule",
      field: "when",
    });
  });
});

describe("listRoutines filters and visibility", () => {
  async function seed() {
    const recurring = await createAgentRoutine("ws-1", creator, { config, when: daily }, ONCE_NOW);
    const event = await createAgentRoutine("ws-1", creator, { config: { ...config, onSchedule: false, events: ["github.push"] }, when: { schedule: null, events: ["github.push"] } }, ONCE_NOW);
    const once = await createAgentRoutine("ws-1", creator, { config, when: { in: "2h" } }, ONCE_NOW);
    const others = { ...personCreator("user-2", "app"), visibility: "private" as const };
    const priv = await createAgentRoutine("ws-1", others, { config: { ...config, title: "Mine" }, when: daily }, ONCE_NOW);
    return { recurring, event, once, priv };
  }

  it("hides one-time routines unless asked for by kind", async () => {
    const { recurring, event } = await seed();
    const ids = (await listRoutines("ws-1", "user-1")).map((routine) => routine.id);
    expect(ids).toContain(recurring.id);
    expect(ids).toContain(event.id);
    expect(ids).toHaveLength(2);
  });

  it("shows a private routine only to the person who made it", async () => {
    const { priv } = await seed();
    expect((await listRoutines("ws-1", "user-1")).map((routine) => routine.id)).not.toContain(priv.id);
    expect((await listRoutines("ws-1", "user-2")).map((routine) => routine.id)).toContain(priv.id);
    expect((await listRoutines("ws-1")).map((routine) => routine.id)).not.toContain(priv.id);
  });

  it("filters by kind, by creator and by one routine", async () => {
    const { recurring, event, once } = await seed();
    expect((await listRoutines("ws-1", "user-1", { kind: "once" })).map((routine) => routine.id)).toEqual([once.id]);
    expect((await listRoutines("ws-1", "user-1", { kind: "event" })).map((routine) => routine.id)).toEqual([event.id]);
    expect((await listRoutines("ws-1", "user-1", { kind: "recurring" })).map((routine) => routine.id)).toEqual([recurring.id]);
    expect((await listRoutines("ws-1", "user-2", { createdBy: "me", kind: "recurring" })).map((routine) => routine.title)).toEqual(["Mine"]);
    expect((await listRoutines("ws-1", "user-1", { taskId: recurring.id })).map((routine) => routine.id)).toEqual([recurring.id]);
  });

  it("filters once routines by whether they have fired", async () => {
    const { once } = await seed();
    Object.assign(db.tables.scheduled_tasks!.find((row) => row.id === once.id)!, { fired_at: "2026-11-16T14:00:00.000Z", enabled: false });
    expect((await listRoutines("ws-1", "user-1", { kind: "once", status: "fired" })).map((routine) => routine.id)).toEqual([once.id]);
    expect(await listRoutines("ws-1", "user-1", { kind: "once", status: "upcoming" })).toEqual([]);
  });
});
