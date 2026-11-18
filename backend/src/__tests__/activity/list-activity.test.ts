import { beforeEach, describe, expect, it, mock } from "bun:test";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import { personCaller, type ToolCaller } from "draft-core/tools";
import { fakeClient, fakeDb } from "../routines/fake-client";
import { activityClient, type Row } from "./activity-fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const TEAMMATE = "33333333-3333-4333-8333-333333333333";

// recordRouteError writes its errors row through the service client.
const serviceDb = fakeDb({ errors: [] });
mock.module("../../db/client", () => ({ serviceClient: fakeClient(serviceDb) }));
const { listActivity } = await import("../../activity/service");
const { createActivityTools } = await import("../../metaharness/tools/definitions/activity");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  serviceDb.tables.errors = [];
});

const at = (minute: number) => `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;

function run(id: string, minute: number, overrides: Row = {}): Row {
  return {
    id, workspace_id: WS, kind: "interactive", session_id: `session-${id}`, scheduled_task_id: null,
    status: "succeeded", outcome: null, trigger: null, summary: null,
    started_at: null, completed_at: null, created_at: at(minute), ...overrides,
  };
}

function routine(id: string, overrides: Row = {}): Row {
  return {
    id, workspace_id: WS, schedule_kind: "cron", config_json: { title: "Weekly digest" },
    created_via: "run", created_by_run_id: null, visibility: "shared", created_by_user_id: ME,
    created_at: at(0), ...overrides,
  };
}

/** A pending one-time routine, as the upcoming list reads it. */
function onceRoutine(id: string, runAt: string, overrides: Row = {}): Row {
  return {
    id, workspace_id: WS, task_type: "agent_routine", schedule_kind: "once", run_at: runAt, timezone: "America/New_York",
    enabled: true, fired_at: null, deleted_at: null, config_json: { title: `Remind ${id}` },
    created_via: "app", created_by_run_id: null, visibility: "shared", created_by_user_id: ME,
    created_at: at(0), ...overrides,
  };
}
const minute = (index: number) => String(index).padStart(2, "0");

describe("listActivity", () => {
  it("lists each run with its routine's title and kind", async () => {
    const tables = {
      agent_runs: [
        run("run-1", 1),
        run("run-2", 2, { kind: "routine", scheduled_task_id: "task-once" }),
        run("run-3", 3, { kind: "routine", scheduled_task_id: "task-rule" }),
      ],
      scheduled_tasks: [
        routine("task-once", { schedule_kind: "once", config_json: { title: "Send the report" } }),
        routine("task-rule"),
      ],
    };

    const { runs } = await listActivity(activityClient(tables), WS, null, ME);

    expect(runs.map((run) => [run.id, run.routineTitle, run.routineKind])).toEqual([
      ["run-3", "Weekly digest", "rule"],
      ["run-2", "Send the report", "once"],
      ["run-1", null, null],
    ]);
  });

  it("lists the routines each run made, with the kind of each", async () => {
    const tables = {
      agent_runs: [run("run-1", 1)],
      scheduled_tasks: [
        routine("task-once", { schedule_kind: "once", config_json: { title: "Remind me Friday" }, created_by_run_id: "run-1", created_at: at(2) }),
        routine("task-weekly", { config_json: { title: "Weekly digest" }, created_by_run_id: "run-1", created_at: at(3) }),
        routine("task-pr", { config_json: { title: "Review new PRs", onSchedule: false }, created_by_run_id: "run-1", created_at: at(4) }),
      ],
    };

    const { runs } = await listActivity(activityClient(tables), WS, null, ME);

    expect(runs[0]!.createdRoutines).toEqual([
      { id: "task-once", title: "Remind me Friday", kind: "once" },
      { id: "task-weekly", title: "Weekly digest", kind: "recurring" },
      { id: "task-pr", title: "Review new PRs", kind: "event" },
    ]);
  });

  it("shows a private routine only to the person who made it", async () => {
    const tables = {
      agent_runs: [run("run-1", 1)],
      scheduled_tasks: [
        routine("task-shared", { config_json: { title: "Team digest" }, created_by_run_id: "run-1", created_at: at(2) }),
        routine("task-mine", { config_json: { title: "My digest" }, visibility: "private", created_by_user_id: ME, created_by_run_id: "run-1", created_at: at(3) }),
        routine("task-theirs", { config_json: { title: "Their digest" }, visibility: "private", created_by_user_id: TEAMMATE, created_by_run_id: "run-1", created_at: at(4) }),
        routine("task-orphan", { config_json: { title: "Orphan digest" }, visibility: "private", created_by_user_id: null, created_by_run_id: "run-1", created_at: at(5) }),
      ],
    };
    const createdTitlesFor = async (viewerId: string | null) =>
      (await listActivity(activityClient(tables), WS, null, viewerId)).runs[0]!.createdRoutines.map((created) => created.title);

    expect(await createdTitlesFor(ME)).toEqual(["Team digest", "My digest"]);
    expect(await createdTitlesFor(TEAMMATE)).toEqual(["Team digest", "Their digest"]);
    expect(await createdTitlesFor(null)).toEqual(["Team digest"]);
  });

  it("keeps the runs without created routines and records the failed read", async () => {
    const tables = {
      agent_runs: [run("run-1", 1, { kind: "routine", scheduled_task_id: "task-weekly" })],
      scheduled_tasks: [routine("task-weekly", { created_by_run_id: "run-1" })],
    };
    const client = activityClient(tables, (table, columns) => table === "scheduled_tasks" && columns.includes("created_by_run_id") && !columns.includes("run_at"));

    const { runs } = await listActivity(client, WS, null, ME);

    expect(runs).toEqual([expect.objectContaining({ id: "run-1", routineTitle: "Weekly digest", routineKind: "rule", createdRoutines: [] })]);
    await settle();
    expect(serviceDb.tables.errors).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        operation: "read",
        message: "Route operation failed: activity_created_routines_failed",
        detail_json: expect.objectContaining({ code: "activity_created_routines_failed" }),
      }),
    ]);
  });

  it("hides another person's private routine title and kind on its run", async () => {
    const tables = {
      agent_runs: [run("run-1", 1, { kind: "routine", scheduled_task_id: "task-private" })],
      scheduled_tasks: [routine("task-private", { config_json: { title: "Secret digest" }, visibility: "private", created_by_user_id: TEAMMATE })],
    };
    const { runs } = await listActivity(activityClient(tables), WS, null, ME);
    expect(runs[0]).toMatchObject({ routineTitle: "Routine", routineKind: null });
    const own = await listActivity(activityClient(tables), WS, null, TEAMMATE);
    expect(own.runs[0]).toMatchObject({ routineTitle: "Secret digest", routineKind: "rule" });
  });

  it("keeps the runs and their created routines, and records the failed title read", async () => {
    const tables = {
      agent_runs: [run("run-1", 1, { kind: "routine", scheduled_task_id: "task-weekly" })],
      scheduled_tasks: [
        routine("task-weekly"),
        routine("task-child", { config_json: { title: "Follow-up" }, created_by_run_id: "run-1", created_at: at(2) }),
      ],
    };
    const client = activityClient(tables, (table, columns) => table === "scheduled_tasks" && !columns.includes("created_by_run_id"));

    const { runs } = await listActivity(client, WS, null, ME);

    expect(runs[0]).toMatchObject({ id: "run-1", routineTitle: "Routine", routineKind: null, createdRoutines: [{ id: "task-child", title: "Follow-up", kind: "recurring" }] });
    await settle();
    expect(serviceDb.tables.errors).toEqual([
      expect.objectContaining({ workspace_id: WS, detail_json: expect.objectContaining({ code: "activity_results_read_failed" }) }),
    ]);
  });
});

describe("activity.list tool", () => {
  it("answers the signed-in person's own private routines and not a teammate's", async () => {
    const tables = {
      agent_runs: [run("run-1", 1)],
      scheduled_tasks: [
        routine("task-mine", { config_json: { title: "My digest" }, visibility: "private", created_by_user_id: ME, created_by_run_id: "run-1", created_at: at(2) }),
      ],
    };
    const tool = createActivityTools(activityClient(tables)).find((candidate) => candidate.name === "activity.list")!;
    const callerFor = (userId: string): ToolCaller => personCaller({ userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "mcp" });
    const createdTitlesFor = async (userId: string) => {
      const result = await tool.run(callerFor(userId), {});
      expect(result).toMatchObject({ status: "ok" });
      return (result as { output: { runs: Array<{ createdRoutines: Array<{ title: string }> }> } }).output.runs[0]!.createdRoutines.map((created) => created.title);
    };

    expect(await createdTitlesFor(ME)).toEqual(["My digest"]);
    expect(await createdTitlesFor(TEAMMATE)).toEqual([]);
  });
});

describe("upcoming routines", () => {
  const users = [
    { id: ME, display_name: "Ido", email: "ido@example.com" },
    { id: TEAMMATE, display_name: null, email: "sam@example.com" },
  ];
  const upcomingFor = async (tables: Record<string, Row[]>, viewerId: string | null) =>
    (await listActivity(activityClient(tables), WS, null, viewerId)).upcoming ?? [];

  it("lists pending one-time routines soonest first and leaves out the rest", async () => {
    const tables = {
      users,
      scheduled_tasks: [
        onceRoutine("later", "2026-12-01T09:00:00.000Z"),
        onceRoutine("soon", "2026-11-20T09:00:00.000Z", { config_json: { title: "Send the report" } }),
        onceRoutine("fired", "2026-11-18T09:00:00.000Z", { fired_at: "2026-11-18T09:00:05.000Z" }),
        onceRoutine("disabled", "2026-11-19T09:00:00.000Z", { enabled: false }),
        onceRoutine("deleted", "2026-11-19T10:00:00.000Z", { deleted_at: "2026-11-17T09:00:00.000Z" }),
        onceRoutine("recurring", "2026-11-19T11:00:00.000Z", { schedule_kind: "cron", run_at: null }),
        onceRoutine("other-task", "2026-11-19T12:00:00.000Z", { task_type: "ingest_source" }),
      ],
    };

    const upcoming = await upcomingFor(tables, ME);

    expect(upcoming).toEqual([
      { id: "soon", title: "Send the report", runAt: "2026-11-20T09:00:00.000Z", timezone: "America/New_York", setBy: { type: "person", name: "Ido" } },
      { id: "later", title: "Remind later", runAt: "2026-12-01T09:00:00.000Z", timezone: "America/New_York", setBy: { type: "person", name: "Ido" } },
    ]);
  });

  it("lists at most 50, the soonest first", async () => {
    const tables = { scheduled_tasks: Array.from({ length: 52 }, (_, index) => onceRoutine(`task-${index}`, `2026-11-20T10:${minute(index)}:00.000Z`)) };

    const upcoming = await upcomingFor(tables, ME);

    expect(upcoming).toHaveLength(50);
    expect(upcoming[0]!.id).toBe("task-0");
    expect(upcoming[49]!.id).toBe("task-49");
  });

  it("does not let a teammate's private routines use up the page", async () => {
    const tables = {
      scheduled_tasks: [
        ...Array.from({ length: 50 }, (_, index) => onceRoutine(`theirs-${index}`, `2026-11-20T10:${minute(index)}:00.000Z`, { visibility: "private", created_by_user_id: TEAMMATE })),
        onceRoutine("shared-later", "2026-11-21T09:00:00.000Z"),
      ],
    };

    expect((await upcomingFor(tables, ME)).map((item) => item.id)).toEqual(["shared-later"]);
  });

  it("shows a private routine only to the person who set it", async () => {
    const tables = {
      scheduled_tasks: [
        onceRoutine("team", "2026-11-20T09:00:00.000Z"),
        onceRoutine("mine", "2026-11-21T09:00:00.000Z", { visibility: "private", created_by_user_id: ME }),
        onceRoutine("theirs", "2026-11-22T09:00:00.000Z", { visibility: "private", created_by_user_id: TEAMMATE }),
      ],
    };
    const idsFor = async (viewerId: string | null) => (await upcomingFor(tables, viewerId)).map((item) => item.id);

    expect(await idsFor(ME)).toEqual(["team", "mine"]);
    expect(await idsFor(TEAMMATE)).toEqual(["team", "theirs"]);
    expect(await idsFor(null)).toEqual(["team"]);
  });

  it("names the person who set a routine, or Someone when that person is gone", async () => {
    const tables = {
      users,
      scheduled_tasks: [
        onceRoutine("mine", "2026-11-20T09:00:00.000Z", { created_by_user_id: ME }),
        onceRoutine("sams", "2026-11-21T09:00:00.000Z", { created_by_user_id: TEAMMATE }),
        onceRoutine("gone", "2026-11-22T09:00:00.000Z", { created_by_user_id: null }),
      ],
    };

    expect((await upcomingFor(tables, ME)).map((item) => item.setBy)).toEqual([
      { type: "person", name: "Ido" },
      { type: "person", name: "sam@example.com" },
      { type: "person", name: "Someone" },
    ]);
  });

  it("names the routine whose run made a routine, or the person when that run had no routine", async () => {
    const tables = {
      users,
      agent_runs: [run("run-1", 1, { kind: "routine", scheduled_task_id: "task-parent" }), run("run-2", 2)],
      scheduled_tasks: [
        routine("task-parent", { config_json: { title: "Weekly digest" } }),
        onceRoutine("from-routine", "2026-11-20T09:00:00.000Z", { created_via: "run", created_by_run_id: "run-1" }),
        onceRoutine("from-session", "2026-11-21T09:00:00.000Z", { created_via: "run", created_by_run_id: "run-2" }),
      ],
    };

    expect((await upcomingFor(tables, ME)).map((item) => item.setBy)).toEqual([
      { type: "routine", routineId: "task-parent", title: "Weekly digest" },
      { type: "person", name: "Ido" },
    ]);
  });

  it("hides a private parent routine's title from other viewers but keeps its id", async () => {
    const tables = {
      agent_runs: [run("run-1", 1, { kind: "routine", scheduled_task_id: "task-parent" })],
      scheduled_tasks: [
        routine("task-parent", { config_json: { title: "Secret digest" }, visibility: "private", created_by_user_id: ME }),
        onceRoutine("made", "2026-11-20T09:00:00.000Z", { created_via: "run", created_by_run_id: "run-1" }),
      ],
    };

    expect((await upcomingFor(tables, TEAMMATE))[0]!.setBy).toEqual({ type: "routine", routineId: "task-parent", title: "Routine" });
    expect((await upcomingFor(tables, ME))[0]!.setBy).toEqual({ type: "routine", routineId: "task-parent", title: "Secret digest" });
  });

  it("keeps the runs, flags the upcoming list, and records the failed read", async () => {
    const tables = {
      agent_runs: [run("run-1", 1)],
      scheduled_tasks: [onceRoutine("soon", "2026-11-20T09:00:00.000Z")],
    };
    const client = activityClient(tables, (table, columns) => table === "scheduled_tasks" && columns.includes("run_at"));

    const page = await listActivity(client, WS, null, ME);

    expect(page.runs.map((run) => run.id)).toEqual(["run-1"]);
    expect(page).toMatchObject({ upcoming: [], upcomingError: true });
    await settle();
    expect(serviceDb.tables.errors).toEqual([
      expect.objectContaining({
        workspace_id: WS,
        operation: "read",
        message: "Route operation failed: activity_upcoming_failed",
        detail_json: expect.objectContaining({ code: "activity_upcoming_failed" }),
      }),
    ]);
  });

  it("flags the upcoming list and records the error when the name read fails", async () => {
    const tables = {
      users,
      scheduled_tasks: [onceRoutine("soon", "2026-11-20T09:00:00.000Z")],
    };
    const client = activityClient(tables, (table) => table === "users");

    const page = await listActivity(client, WS, null, ME);

    expect(page).toMatchObject({ runs: [], upcoming: [], upcomingError: true });
    await settle();
    expect(serviceDb.tables.errors).toEqual([
      expect.objectContaining({ detail_json: expect.objectContaining({ code: "activity_upcoming_failed" }) }),
    ]);
  });

  it("leaves upcoming off the older pages", async () => {
    const tables = {
      agent_runs: [run("run-1", 1)],
      scheduled_tasks: [onceRoutine("soon", "2026-11-20T09:00:00.000Z")],
    };

    const page = await listActivity(activityClient(tables), WS, { at: at(5), id: "run-9" }, ME);

    expect(page.runs.map((item) => item.id)).toEqual(["run-1"]);
    expect(page).not.toHaveProperty("upcoming");
    expect(page).not.toHaveProperty("upcomingError");
  });

  it("returns the upcoming routines with the activity.list tool's first page", async () => {
    const tables = {
      agent_runs: [run("run-1", 1)],
      scheduled_tasks: [onceRoutine("task-soon", "2026-11-20T09:00:00.000Z")],
    };
    const tool = createActivityTools(activityClient(tables)).find((candidate) => candidate.name === "activity.list")!;
    const caller: ToolCaller = personCaller({ userId: parseUserId(ME), workspaceId: parseWorkspaceId(WS), via: "mcp" });

    const result = await tool.run(caller, {});

    expect(result).toMatchObject({ status: "ok", output: { upcoming: [expect.objectContaining({ id: "task-soon", runAt: "2026-11-20T09:00:00.000Z" })] } });
  });
});
