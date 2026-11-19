import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { loadRoutineRunSource, routineRunPrompt } from "../../cloud-sessions/routine-seed";
import { fakeClient, fakeDb, failingOn, type FakeDb } from "../routines/fake-client";

const WS = "11111111-1111-4111-8111-111111111111";
const OWNER = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";
const TASK = "55555555-5555-4555-8555-555555555555";
const RUN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VIEWER = "88888888-8888-4888-8888-888888888888";

function seed(overrides: Partial<Record<string, unknown>> = {}, task: Partial<Record<string, unknown>> = {}, trigger: unknown = { type: "manual", requestedBy: OWNER }): FakeDb {
  return fakeDb({
    sessions: [
      {
        id: RUN,
        workspace_id: WS,
        session_type: "routine",
        status: "ended",
        end_reason: "completed",
        scheduled_task_id: TASK,
        idempotency_key: `${TASK}:manual:req-1`,
        started_at: "2026-11-17T09:00:00.000Z",
        ended_at: "2026-11-17T09:04:00.000Z",
        deleted_at: null,
        ...overrides,
      },
    ],
    scheduled_tasks: [
      {
        id: TASK,
        workspace_id: WS,
        task_type: "agent_routine",
        visibility: "shared",
        created_by_user_id: OWNER,
        deleted_at: null,
        config_json: { title: "Daily   digest", prompt: "Summarize.", harness: "claude", model: null },
        ...task,
      },
    ],
    agent_runs: [{ id: "run-row", workspace_id: WS, session_id: RUN, trigger }],
    users: [{ id: OWNER, display_name: "Ido Dekerobo", email: "ido@example.test" }],
    errors: [],
  });
}

const load = (db: FakeDb, viewer = VIEWER, sessionId = RUN) => loadRoutineRunSource(fakeClient(db), WS, viewer, sessionId);

describe("loadRoutineRunSource", () => {
  let logs: unknown[][];
  let spies: Array<{ mockRestore(): void }>;
  beforeEach(() => {
    logs = [];
    spies = ["log", "error", "warn", "info"].map((level) => spyOn(console, level as "log").mockImplementation((...args: unknown[]) => void logs.push(args)));
  });
  afterEach(() => spies.forEach((spy) => spy.mockRestore()));

  it("reads a finished run of a shared routine, with its routine, start and end in the first message", async () => {
    const result = await load(seed());

    expect(result).toEqual({
      ok: true,
      source: {
        routineId: TASK,
        routineTitle: "Daily digest",
        prompt: [
          "This chat continues the history of a routine run.",
          "",
          `Routine: "Daily digest" (taskId ${TASK})`,
          `Run: sessionId ${RUN}`,
          "Start reason: run now",
          "Started by: Ido Dekerobo",
          "Started: 2026-11-17T09:00:00.000Z",
          "End status: completed at 2026-11-17T09:04:00.000Z",
          "",
          "Call `routines.runs` with this routine's `taskId` and `sessionId`, and `transcript: true`. Pass `nextCursor` back as `cursor` for more.",
          "",
          "The user wants to continue this history. Read only what you need.",
        ].join("\n"),
      },
    });
  });

  it("names the schedule for a scheduled run, and the event for an event run", async () => {
    const scheduled = seed({ idempotency_key: `${TASK}:2026-11-17T09:00:00.000Z` }, {}, { type: "cron" });
    const scheduledResult = await load(scheduled);
    expect(scheduledResult.ok && scheduledResult.source.prompt).toContain("Start reason: schedule\nStarted by: the routine's schedule");

    const event = seed({ idempotency_key: `${TASK}:linear.issue_created:evt-1` }, {}, { type: "event" });
    const eventResult = await load(event);
    expect(eventResult.ok && eventResult.source.prompt).toContain("Start reason: event\nStarted by: an event (A Linear issue is created)");
  });

  it("does not find a run of another workspace, a run that is not a routine run, or a run that was deleted", async () => {
    expect(await load(seed({ workspace_id: "other-ws" }))).toEqual({ ok: false, status: 404, error: "routine_run_not_found" });
    expect(await load(seed({ session_type: "interactive" }))).toEqual({ ok: false, status: 404, error: "routine_run_not_found" });
    expect(await load(seed({ deleted_at: "2026-11-18T00:00:00.000Z" }))).toEqual({ ok: false, status: 404, error: "routine_run_not_found" });
    expect(await load(seed(), VIEWER, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toEqual({ ok: false, status: 404, error: "routine_run_not_found" });
  });

  it("hides a private routine from a viewer who did not make it, as if it did not exist", async () => {
    const db = seed({}, { visibility: "private" });
    expect(await load(db, OTHER)).toEqual({ ok: false, status: 404, error: "routine_run_not_found" });
  });

  it("refuses a private routine's run even to its owner, since a cloud chat cannot read it", async () => {
    expect(await load(seed({}, { visibility: "private" }), OWNER)).toEqual({ ok: false, status: 409, error: "routine_run_private" });
  });

  it("refuses a run that is still going, since its history is not complete", async () => {
    expect(await load(seed({ status: "live", end_reason: null, ended_at: null }))).toEqual({ ok: false, status: 409, error: "routine_run_not_finished" });
  });

  it("refuses a run that was skipped, since it has no history", async () => {
    expect(await load(seed({ end_reason: "skipped" }))).toEqual({ ok: false, status: 409, error: "routine_run_skipped" });
  });

  it("records a failed lookup, and returns a 500 that the start can answer", async () => {
    const db = seed();
    const result = await loadRoutineRunSource(failingOn(fakeClient(db), "sessions"), WS, VIEWER, RUN);

    expect(result).toMatchObject({ ok: false, status: 500, error: "routine_run_lookup_failed" });
    expect(db.tables.errors).toHaveLength(1);
    expect((db.tables.errors![0]!.detail_json as { code?: string }).code).toBe("routine_run_lookup_failed");
  });
});

describe("routineRunPrompt", () => {
  it("names the routine, the run and the start, and says how to read the history", () => {
    const text = routineRunPrompt({
      routineId: TASK,
      routineTitle: "Digest",
      routineSessionId: RUN,
      start: { type: "schedule" },
      startedBy: "the routine's schedule",
      startedAt: "2026-11-17T09:00:00.000Z",
      status: "failed",
      endedAt: null,
    });
    expect(text).toContain(`(taskId ${TASK})`);
    expect(text).toContain(`sessionId ${RUN}`);
    expect(text).toContain("End status: failed\n");
    expect(text).toContain("Pass `nextCursor` back as `cursor` for more.");
  });
});
