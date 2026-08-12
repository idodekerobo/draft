import { describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSchedulingTick } from "../../scheduling/tick";
import type { ScheduledTaskRow } from "../../types/tables";

function task(overrides: Partial<ScheduledTaskRow>): ScheduledTaskRow {
  return {
    id: "task-1",
    workspace_id: "workspace-1",
    source_connection_id: null,
    task_type: "synthesize_workspace",
    task_key: "test",
    schedule_kind: "interval",
    cron_expression: null,
    interval_seconds: 300,
    timezone: "UTC",
    enabled: true,
    config_json: {},
    next_due_at: "2026-08-05T10:00:00.000Z",
    last_enqueued_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeClient(dueTasks: ScheduledTaskRow[]) {
  const updates: { table: string; payload: Record<string, unknown>; id: string }[] = [];
  const errorInserts: Record<string, unknown>[] = [];

  const client = {
    from: (table: string) => {
      if (table === "scheduled_tasks") {
        return {
          select: () => ({
            eq: () => ({
              lte: async () => ({ data: dueTasks, error: null }),
            }),
          }),
          update: (payload: Record<string, unknown>) => ({
            eq: (_f1: string, id: string) => ({
              eq: async () => {
                updates.push({ table, payload, id });
                return { data: null, error: null };
              },
            }),
          }),
        };
      }
      if (table === "errors") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            errorInserts.push(payload);
            return { data: null, error: null };
          },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { client, updates, errorInserts };
}

const fakeConfig = {} as never;

describe("runSchedulingTick", () => {
  it("dispatches each due task and always advances next_due_at, even on success", async () => {
    const dispatch = mock(async () => undefined);
    const dueTask = task({ id: "task-a" });
    const { client, updates, errorInserts } = fakeClient([dueTask]);
    const now = new Date("2026-08-05T10:00:30.000Z");

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ task: dueTask, occurrenceAt: dueTask.next_due_at }),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("task-a");
    expect(updates[0].payload.next_due_at).toBe(new Date("2026-08-05T10:05:00.000Z").toISOString());
    expect(errorInserts).toHaveLength(0);
  });

  it("logs to errors and still advances next_due_at when dispatch throws", async () => {
    const dispatch = mock(async () => {
      throw new Error("boom");
    });
    const dueTask = task({ id: "task-b" });
    const { client, updates, errorInserts } = fakeClient([dueTask]);
    const now = new Date("2026-08-05T10:00:30.000Z");

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch });

    expect(errorInserts).toHaveLength(1);
    expect(errorInserts[0]).toMatchObject({
      workspace_id: "workspace-1",
      scheduled_task_id: "task-b",
      operation: "scheduling",
    });
    // Still advances -- a persistently failing task must retry at its next
    // natural occurrence, not spin every tick.
    expect(updates).toHaveLength(1);
  });

  it("captures a useful message when dispatch throws a non-Error (e.g. a PostgrestError-shaped object)", async () => {
    const dispatch = mock(async () => {
      throw { message: "duplicate key value violates unique constraint", code: "23505" };
    });
    const dueTask = task({ id: "task-c" });
    const { client, errorInserts } = fakeClient([dueTask]);

    await runSchedulingTick({ client, config: fakeConfig, now: new Date("2026-08-05T10:00:30.000Z"), dispatch });

    expect(errorInserts[0].detail_json).toMatchObject({
      error: { message: "duplicate key value violates unique constraint", code: "23505" },
    });
  });

  it("processes remaining due tasks even after an earlier one fails", async () => {
    const dispatch = mock(async (options: { task: ScheduledTaskRow }) => {
      if (options.task.id === "task-fail") throw new Error("boom");
    });
    const failing = task({ id: "task-fail" });
    const ok = task({ id: "task-ok" });
    const { client, updates } = fakeClient([failing, ok]);
    const now = new Date("2026-08-05T10:00:30.000Z");

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(updates.map((u) => u.id)).toEqual(["task-fail", "task-ok"]);
  });

  it("does nothing when no tasks are due", async () => {
    const dispatch = mock(async () => undefined);
    const { client, updates } = fakeClient([]);

    await runSchedulingTick({ client, config: fakeConfig, now: new Date(), dispatch });

    expect(dispatch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });
});
