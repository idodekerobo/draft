import { describe, expect, it } from "bun:test";
import { RoutineInput, RoutineListFilter, RoutinePatch, RoutineWhen, routineProvidersForWhen } from "../routines";

const base = { title: "Weekly digest", prompt: "Summarize the week", when: { in: "1h" } };

describe("RoutineWhen", () => {
  it.each([
    ["a delay", { in: "10m" }],
    ["a delay in days", { in: "3d" }],
    ["a time with an offset", { at: "2026-11-20T09:00:00+02:00" }],
    ["a time in UTC", { at: "2026-11-20T09:00:00Z" }],
    ["a preset schedule", { schedule: { preset: "daily", time: "09:00", timezone: "UTC" } }],
    ["a cron schedule", { schedule: { cron: "0 9 * * 1-5", timezone: "America/New_York" } }],
    ["a schedule turned off", { schedule: null }],
    ["events only", { events: ["github.push", "linear.issue_created"] }],
    ["a schedule and events", { schedule: { preset: "weekdays", time: "08:30" }, events: ["fireflies.meeting_summarized"] }],
  ])("accepts %s", (_name, when) => {
    expect(RoutineWhen.safeParse(when).success).toBe(true);
  });

  it.each([
    ["a zero delay", { in: "0m" }],
    ["a delay without a unit", { in: "10" }],
    ["a delay with a leading zero", { in: "01h" }],
    ["an unsupported unit", { in: "1w" }],
    ["a time without an offset", { at: "2026-11-20T09:00:00" }],
    ["an unknown event", { events: ["github.star"] }],
    ["more than ten events", { events: Array(11).fill("github.push") }],
    ["a cron that is too short", { schedule: { cron: "0 9", timezone: "UTC" } }],
    ["a delay mixed with events", { in: "10m", events: ["github.push"] }],
  ])("rejects %s", (_name, when) => {
    expect(RoutineWhen.safeParse(when).success).toBe(false);
  });
});

describe("RoutineInput", () => {
  it("accepts a when rule without a harness", () => {
    expect(RoutineInput.safeParse(base).success).toBe(true);
  });

  it("requires when", () => {
    const { when: _when, ...withoutWhen } = base;
    expect(RoutineInput.safeParse(withoutWhen).success).toBe(false);
  });

  it("rejects the old flat schedule fields as invalid input", () => {
    for (const legacy of [{ schedule: { preset: "daily" } }, { events: ["github.push"] }, { onSchedule: false }]) {
      expect(RoutineInput.safeParse({ ...base, ...legacy }).success).toBe(false);
    }
  });
});

describe("RoutinePatch", () => {
  it("accepts a when change", () => {
    expect(RoutinePatch.safeParse({ when: { events: ["linear.issue_completed"] } }).success).toBe(true);
  });

  it("accepts null to turn posting and GitHub access off", () => {
    expect(RoutinePatch.safeParse({ postChannels: null, github: null }).success).toBe(true);
  });

  it("rejects the old flat schedule fields as invalid input", () => {
    expect(RoutinePatch.safeParse({ preset: "daily" }).success).toBe(false);
    expect(RoutinePatch.safeParse({ onSchedule: false }).success).toBe(false);
    expect(RoutinePatch.safeParse({ events: ["github.push"] }).success).toBe(false);
  });
});

describe("RoutineListFilter", () => {
  it("accepts each filter", () => {
    const filter = { taskId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", kind: "event", status: "fired", createdBy: "me" };
    expect(RoutineListFilter.safeParse(filter).success).toBe(true);
  });

  it("rejects a malformed task id and unknown keys", () => {
    expect(RoutineListFilter.safeParse({ taskId: "not-a-uuid" }).success).toBe(false);
    expect(RoutineListFilter.safeParse({ kind: "weekly" }).success).toBe(false);
    expect(RoutineListFilter.safeParse({ createdBy: "anyone", extra: true }).success).toBe(false);
  });
});

describe("routineProvidersForWhen", () => {
  it("collects the connections of the events", () => {
    expect(routineProvidersForWhen({ events: ["linear.issue_created", "github.push"] }, {})).toEqual(["github", "linear"]);
  });

  it("adds Slack when the routine can notify", () => {
    expect(routineProvidersForWhen({ events: ["fireflies.meeting_summarized"] }, { canNotify: true })).toEqual(["fireflies", "slack"]);
  });

  it("needs no connection for a delay, a time or a plain schedule", () => {
    expect(routineProvidersForWhen({ in: "1h" }, {})).toEqual([]);
    expect(routineProvidersForWhen({ at: "2026-11-20T09:00:00Z" }, {})).toEqual([]);
    expect(routineProvidersForWhen({ schedule: { preset: "daily" } }, {})).toEqual([]);
  });

  it("adds GitHub access and posting to the connections", () => {
    const access = { github: { repos: ["acme/app"], access: "read" }, postChannels: "joined" } as const;
    expect(routineProvidersForWhen({ in: "1h" }, access)).toEqual(["github", "slack"]);
  });
});
