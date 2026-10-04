import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

const caller = { userId: "user-1", accessToken: "token-1" };
let accessResult: Response | null = null;
let runsError: { message: string } | null = null;
let updateError: { message: string } | null = null;
let errorRows: Row[] = [];
let usersError: { message: string } | null = null;

type Row = Record<string, unknown>;
let tables: Record<string, Row[]> = {};

function queryBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let updatePayload: Row | undefined;

  const matches = () =>
    (tables[table] ?? []).filter(
      (row) => eqs.every(([col, v]) => row[col] === v) && ins.every(([col, vs]) => vs.includes(row[col])),
    );

  const builder = {
    select: () => builder,
    update: (payload: Row) => {
      updatePayload = payload;
      return builder;
    },
    eq: (col: string, value: unknown) => {
      eqs.push([col, value]);
      return builder;
    },
    in: (col: string, values: unknown[]) => {
      ins.push([col, values]);
      return builder;
    },
    insert: async (payload: Row) => {
      if (table === "errors") errorRows.push(payload);
      return { data: null, error: null };
    },
    order: () => builder,
    limit: () => builder,
    async maybeSingle() {
      if (updatePayload) {
        if (updateError) return { data: null, error: updateError };
        const row = matches()[0];
        if (!row) return { data: null, error: null };
        Object.assign(row, updatePayload);
        return { data: row, error: null };
      }
      return { data: matches()[0] ?? null, error: null };
    },
    then(resolve: (value: unknown) => unknown) {
      if (table === "synthesis_runs" && runsError) return resolve({ data: null, error: runsError });
      if (table === "users" && usersError) return resolve({ data: null, error: usersError });
      return resolve({ data: matches(), error: null });
    },
  };
  return builder;
}

mock.module("../../auth/withAuth", () => ({
  withAuth: (handler: (request: Request, authenticatedCaller: typeof caller) => unknown) =>
    (request: Request) => handler(request, caller),
}));
mock.module("../../auth/workspace-access", () => ({
  assertWorkspaceAccess: async () => accessResult,
}));
mock.module("../../db/client", () => ({
  serviceClient: { from: (table: string) => queryBuilder(table) },
}));

const routeModule = await import("../../routes/schedules");

function task(overrides: Row): Row {
  return {
    id: "task-1",
    workspace_id: "ws-1",
    source_connection_id: null,
    task_type: "synthesize_workspace",
    task_key: "ws-1",
    schedule_kind: "cron",
    cron_expression: "0 0,4,8,9-18,22 * * *",
    interval_seconds: null,
    timezone: "UTC",
    enabled: true,
    config_json: {},
    next_due_at: "2026-10-04T10:00:00.000Z",
    last_enqueued_at: "2026-10-04T09:00:00.000Z",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by_user_id: null,
    ...overrides,
  };
}

function get(workspaceId = "ws-1") {
  return routeModule.GET(Object.assign(new Request("http://internal.test"), { params: { id: workspaceId } }) as never);
}

function patch(taskId: string, body: unknown, workspaceId = "ws-1") {
  return routeModule.PATCH(
    Object.assign(new Request("http://internal.test", { method: "PATCH", body: JSON.stringify(body) }), {
      params: { id: workspaceId, taskId },
    }) as never,
  );
}

describe("schedules routes", () => {
  beforeEach(() => {
    accessResult = null;
    runsError = null;
    updateError = null;
    errorRows = [];
    usersError = null;
    tables = {
      scheduled_tasks: [
        task({}),
        task({ id: "task-2", task_type: "summarize_sessions", task_key: "ws-1", cron_expression: "0 3 * * *" }),
        task({ id: "task-3", task_type: "slack_backfill", task_key: "conn-1", source_connection_id: "conn-1" }),
        task({
          id: "task-4",
          task_type: "ingest_source",
          task_key: "conn-1",
          source_connection_id: "conn-1",
          schedule_kind: "interval",
          cron_expression: null,
          interval_seconds: 3600,
        }),
        task({ id: "task-other", workspace_id: "ws-2" }),
      ],
      source_connections: [
        { id: "conn-1", workspace_id: "ws-1", provider: "slack", status: "active", display_name: "Acme Slack" },
      ],
      synthesis_runs: [
        {
          workspace_id: "ws-1",
          status: "succeeded",
          outcome: "changed",
          completed_at: "2026-10-04T08:05:00.000Z",
        },
      ],
      users: [{ id: "user-1", display_name: "Ido", email: "ido@example.com" }],
    };
    spyOn(console, "log").mockImplementation(() => {});
    spyOn(console, "error").mockImplementation(() => {});
  });

  describe("GET", () => {
    it("lists routines, hides one-time backfills, and attaches the synthesis result", async () => {
      const response = await get();
      const body = (await response.json()) as { routines: Row[]; canEdit: boolean };
      expect(response.status).toBe(200);
      expect(body.canEdit).toBe(true);
      expect(body.routines.map((r) => r.id)).toEqual(["task-1", "task-2", "task-4"]);

      const [synthesis, sessions, slack] = body.routines;
      expect(synthesis).toMatchObject({
        preset: "draft_default",
        editable: "full",
        lastRun: { status: "succeeded", outcome: "changed" },
      });
      expect(sessions).toMatchObject({ preset: "daily", time: "03:00", lastRun: null });
      expect(slack).toMatchObject({ editable: "toggle_only", connectionLabel: "Acme Slack", needsReconnect: false });
    });

    it("flags a disconnected Slack connection", async () => {
      tables.source_connections![0]!.status = "revoked";
      const body = (await (await get()).json()) as { routines: Row[] };
      expect(body.routines.find((r) => r.id === "task-4")).toMatchObject({ needsReconnect: true });
    });

    it("keeps the list when the run lookup fails, and records it", async () => {
      runsError = { message: "boom" };
      const body = (await (await get()).json()) as { routines: Row[] };
      expect(body.routines).toHaveLength(3);
      expect(body.routines[0]).toMatchObject({ lastRun: null });
      await Bun.sleep(10);
      expect(errorRows).toHaveLength(1);
      expect(errorRows[0]).toMatchObject({ workspace_id: "ws-1", operation: "read" });
      expect(errorRows[0]!.detail_json).toMatchObject({ code: "schedules_last_run_failed" });
    });

    it("keeps the list when the editor name lookup fails, and records it", async () => {
      tables.scheduled_tasks![1]!.updated_by_user_id = "user-1";
      usersError = { message: "boom" };
      const body = (await (await get()).json()) as { routines: Row[] };
      expect(body.routines[1]).toMatchObject({ updatedByName: null });
      await Bun.sleep(10);
      expect(errorRows[0]!.detail_json).toMatchObject({ code: "schedules_editor_names_failed" });
    });

    it("shows an unparseable or interval schedule as custom/managed", async () => {
      tables.scheduled_tasks![1]!.cron_expression = "every day";
      const body = (await (await get()).json()) as { routines: Row[] };
      expect(body.routines[1]).toMatchObject({ preset: "custom" });
      expect(body.routines[2]).toMatchObject({ scheduleDescription: "Every hour" });
    });

    it("returns an empty list for a workspace with no rows", async () => {
      tables.scheduled_tasks = [];
      expect(await (await get()).json()).toEqual({ routines: [], canEdit: true });
    });

    it("passes through an access denial", async () => {
      accessResult = Response.json({ error: "forbidden" }, { status: 403 });
      expect((await get()).status).toBe(403);
    });
  });

  describe("PATCH", () => {
    it("toggles enabled and records the editor", async () => {
      const response = await patch("task-2", { enabled: false });
      expect(response.status).toBe(200);
      expect(tables.scheduled_tasks![1]).toMatchObject({ enabled: false, updated_by_user_id: "user-1" });
      expect(await response.json()).toMatchObject({ enabled: false, nextRunAt: null, updatedByName: "Ido" });
    });

    it("rebuilds cron and next_due_at when the schedule changes", async () => {
      const response = await patch("task-2", { preset: "daily", time: "07:30", timezone: "Europe/London" });
      expect(response.status).toBe(200);
      expect(tables.scheduled_tasks![1]).toMatchObject({
        cron_expression: "30 7 * * *",
        timezone: "Europe/London",
        schedule_kind: "cron",
      });
      expect(new Date(tables.scheduled_tasks![1]!.next_due_at as string).getTime()).toBeGreaterThan(Date.now());
    });

    it("recomputes next_due_at when a stale paused row is enabled", async () => {
      Object.assign(tables.scheduled_tasks![0]!, { enabled: false, next_due_at: "2025-01-01T00:00:00.000Z" });
      expect((await patch("task-1", { enabled: true })).status).toBe(200);
      expect(new Date(tables.scheduled_tasks![0]!.next_due_at as string).getTime()).toBeGreaterThan(Date.now());
    });

    it("restores the Draft default exactly", async () => {
      await patch("task-1", { preset: "hourly", timezone: "UTC" });
      await patch("task-1", { preset: "draft_default" });
      expect(tables.scheduled_tasks![0]).toMatchObject({
        cron_expression: "0 0,4,8,9-18,22 * * *",
        timezone: "UTC",
      });
    });

    it("rejects raw cron and unknown fields", async () => {
      const response = await patch("task-1", { cron_expression: "* * * * *" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_body", field: "cron_expression" });
    });

    it("rejects schedule fields on a toggle-only routine", async () => {
      const response = await patch("task-4", { preset: "hourly" });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "field_not_editable" });
      expect((await patch("task-4", { enabled: false })).status).toBe(200);
    });

    it("rejects bad time, timezone, and weekday", async () => {
      expect((await patch("task-1", { preset: "daily", time: "99:99" })).status).toBe(400);
      expect((await patch("task-1", { preset: "daily", time: "09:00", timezone: "Nope/Nope" })).status).toBe(400);
      expect((await patch("task-1", { preset: "weekly", time: "09:00", weekday: "someday" })).status).toBe(400);
    });

    it("returns 400 and records the task when a stored schedule cannot be parsed on enable", async () => {
      Object.assign(tables.scheduled_tasks![1]!, { enabled: false, cron_expression: "not a cron" });
      const response = await patch("task-2", { enabled: true });
      expect(response.status).toBe(400);
      await Bun.sleep(10);
      expect(errorRows[0]).toMatchObject({ workspace_id: "ws-1", scheduled_task_id: "task-2", operation: "scheduling" });
      expect(errorRows[0]!.detail_json).toMatchObject({ code: "schedules_invalid_stored_cron" });
    });

    it("returns 404 for another workspace's task and for backfill rows", async () => {
      expect((await patch("task-other", { enabled: false })).status).toBe(404);
      expect((await patch("task-3", { enabled: false })).status).toBe(404);
    });

    it("returns 500 and leaves the caller to roll back when the update fails", async () => {
      updateError = { message: "db down" };
      expect((await patch("task-2", { enabled: false })).status).toBe(500);
    });

    it("returns 400 on invalid JSON", async () => {
      const response = await routeModule.PATCH(
        Object.assign(new Request("http://internal.test", { method: "PATCH", body: "{" }), {
          params: { id: "ws-1", taskId: "task-1" },
        }) as never,
      );
      expect(response.status).toBe(400);
    });
  });
});
