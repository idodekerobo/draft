import { beforeEach, describe, expect, it, mock } from "bun:test";
import { parseUserId, parseWorkspaceId } from "draft-core/run-spec";
import type { ToolCaller } from "draft-core/tools";
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
    const client = activityClient(tables, (table, columns) => table === "scheduled_tasks" && columns.includes("created_by_run_id"));

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
    const callerFor = (userId: string): ToolCaller => ({ type: "user", userId: parseUserId(userId), workspaceId: parseWorkspaceId(WS), via: "mcp" });
    const createdTitlesFor = async (userId: string) => {
      const result = await tool.run(callerFor(userId), {});
      expect(result).toMatchObject({ status: "ok" });
      return (result as { output: { runs: Array<{ createdRoutines: Array<{ title: string }> }> } }).output.runs[0]!.createdRoutines.map((created) => created.title);
    };

    expect(await createdTitlesFor(ME)).toEqual(["My digest"]);
    expect(await createdTitlesFor(TEAMMATE)).toEqual([]);
  });
});
