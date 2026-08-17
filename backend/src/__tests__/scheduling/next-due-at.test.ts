import { describe, expect, it } from "bun:test";
import { computeNextDueAt } from "../../scheduling/next-due-at";
import type { ScheduledTaskRow } from "../../types/tables";

function baseTask(overrides: Partial<ScheduledTaskRow>): ScheduledTaskRow {
  return {
    id: "task-1",
    workspace_id: "workspace-1",
    source_connection_id: null,
    task_type: "synthesize_workspace",
    task_key: "test",
    schedule_kind: "cron",
    cron_expression: null,
    interval_seconds: null,
    timezone: "UTC",
    enabled: true,
    config_json: {},
    next_due_at: null,
    last_enqueued_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeNextDueAt", () => {
  it("computes the next absolute occurrence for a cron schedule", () => {
    const task = baseTask({ schedule_kind: "cron", cron_expression: "0 0 8 * * *" });
    const from = new Date("2026-08-05T10:00:00.000Z");

    const next = computeNextDueAt(task, from);

    expect(next.toISOString()).toBe("2026-08-06T08:00:00.000Z");
  });

  it("respects a non-UTC timezone for cron schedules", () => {
    const task = baseTask({
      schedule_kind: "cron",
      cron_expression: "0 0 8 * * *",
      timezone: "America/New_York",
    });
    const from = new Date("2026-08-05T10:00:00.000Z");

    const next = computeNextDueAt(task, from);

    // 8am America/New_York on 2026-08-05 is 12:00 UTC (EDT, UTC-4) --
    // already past `from` (10:00 UTC), so the next occurrence is the
    // *same* day at noon UTC, not the next day.
    expect(next.toISOString()).toBe("2026-08-05T12:00:00.000Z");
  });

  it("throws for a cron task with no cron_expression", () => {
    const task = baseTask({ schedule_kind: "cron", cron_expression: null });
    expect(() => computeNextDueAt(task, new Date())).toThrow();
  });

  it("computes interval + previous next_due_at when still in the future", () => {
    const task = baseTask({
      schedule_kind: "interval",
      interval_seconds: 300,
      next_due_at: "2026-08-05T10:00:00.000Z",
    });
    const from = new Date("2026-08-05T09:58:00.000Z");

    const next = computeNextDueAt(task, from);

    expect(next.toISOString()).toBe("2026-08-05T10:05:00.000Z");
  });

  it("falls back to `from` when no prior next_due_at exists (first registration)", () => {
    const task = baseTask({
      schedule_kind: "interval",
      interval_seconds: 300,
      next_due_at: null,
    });
    const from = new Date("2026-08-05T09:58:00.000Z");

    const next = computeNextDueAt(task, from);

    expect(next.toISOString()).toBe("2026-08-05T10:03:00.000Z");
  });

  it("catches up to `now` (not a catch-up storm) when interval math falls behind after downtime", () => {
    const task = baseTask({
      schedule_kind: "interval",
      interval_seconds: 300,
      next_due_at: "2026-08-05T09:00:00.000Z",
    });
    // Process was down for an hour past the last occurrence.
    const from = new Date("2026-08-05T10:00:00.000Z");

    const next = computeNextDueAt(task, from);

    // previous(09:00) + 300s = 09:05, which is before `from` -- clamps to
    // `from` (fires once, immediately, not once per missed 5-minute tick).
    expect(next.toISOString()).toBe(from.toISOString());
  });

  it("throws for an interval task with no interval_seconds", () => {
    const task = baseTask({ schedule_kind: "interval", interval_seconds: null });
    expect(() => computeNextDueAt(task, new Date())).toThrow();
  });
});
