import { beforeEach, describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { __resetDrainForTests, drainEventInbox, EVENT_MAX_ATTEMPTS, EVENTS_PER_RUN } from "../../events/drain";
import type { dispatchAgentRoutine } from "../../routines/dispatch-routine";
import type { RoutineEventPayload } from "../../routines/event";
import type { SandboxDeploymentConfig } from "../../sandbox";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

type Dispatch = typeof dispatchAgentRoutine;
type Options = Parameters<Dispatch>[0];
type Outcome = Awaited<ReturnType<Dispatch>>;
type Row = Record<string, unknown>;

const WS = "ws-1";
const TASK = "task-1";
const KEY = "github:org/repo#1";
const CONFIG = {} as SandboxDeploymentConfig;
const NOW = new Date("2026-11-16T12:00:00.000Z");

const at = (minute: number) => `2026-11-16T10:${String(minute).padStart(2, "0")}:00.000Z`;

beforeEach(() => __resetDrainForTests());

function row(id: string, fields: Row): Row {
  return {
    id,
    workspace_id: WS,
    scheduled_task_id: TASK,
    origin: "webhook",
    event_name: "github.push",
    dedupe_key: `${TASK}:${id}`,
    concurrency_key: TASK,
    source_item_id: null,
    payload: {},
    status: "pending",
    attempts: 0,
    lease_until: null,
    claimed_by_run_id: null,
    failure_code: null,
    created_at: at(1),
    updated_at: at(1),
    ...fields,
  };
}

const routineEvent = (id: string): RoutineEventPayload => ({
  name: "github.push",
  eventId: `evt-${id}`,
  description: "commits were pushed to the default branch",
  providerLabel: "GitHub",
  sourceItemId: "src-1",
  facts: [],
  title: "Push",
  text: "",
  truncated: false,
});

const webhook = (id: string, key: string, minute: number, fields: Row = {}) =>
  row(id, { concurrency_key: key, payload: { type: "webhook", event: routineEvent(id) }, created_at: at(minute), ...fields });

const hidden = (id: string, minute: number, skip: { code: string; note: string }) =>
  row(id, { concurrency_key: KEY, payload: { type: "webhook", event: routineEvent(id), skip }, created_at: at(minute) });

const timer = (id: string, minute: number) =>
  row(id, { origin: "schedule", event_name: "timer.fired", payload: { type: "timer", occurrenceAt: at(minute) }, created_at: at(minute) });

const manual = (id: string, minute: number) =>
  row(id, { origin: "manual", event_name: "manual.run", payload: { type: "manual", requestedBy: "user-1" }, created_at: at(minute) });

const task = (fields: Row = {}): Row => ({
  id: TASK,
  workspace_id: WS,
  task_type: "agent_routine",
  schedule_kind: "cron",
  enabled: true,
  deleted_at: null,
  fired_at: null,
  created_by_user_id: "user-1",
  timezone: "UTC",
  config_json: {},
  ...fields,
});

/** Mirrors claim_agent_events for pending rows: oldest first, one attempt counted per claim. */
function claimPending(db: FakeDb) {
  return (args: Record<string, unknown>) => {
    const ready = db.tables.agent_events!
      .filter((event) => event.status === "pending")
      .sort((a, b) => (a.created_at as string).localeCompare(b.created_at as string))
      .slice(0, args.p_limit as number);
    for (const event of ready) {
      Object.assign(event, { status: "claimed", attempts: (event.attempts as number) + 1, lease_until: "2099-01-01T00:00:00.000Z" });
    }
    return { data: ready.map((event) => ({ ...event })) };
  };
}

function setup(events: Row[], options: { tasks?: Row[]; sessions?: Row[] } = {}) {
  const db = fakeDb(
    { scheduled_tasks: options.tasks ?? [task()], agent_events: events, sessions: options.sessions ?? [], agent_run_events: [], errors: [] },
    { unique: { agent_events: [["workspace_id", "dedupe_key"]] } },
  );
  db.rpcs.claim_agent_events = claimPending(db);
  return { db, client: fakeClient(db) };
}

const drain = (client: SupabaseClient, dispatch: Dispatch, now: () => Date = () => NOW) =>
  drainEventInbox({ client, config: CONFIG, dispatch, now });

const started = (runId = "run-1"): Outcome => ({ status: "started", sessionId: "s-1", runId });

function recorder(outcome: Outcome | ((options: Options) => Outcome) = started()) {
  const calls: Options[] = [];
  const dispatch: Dispatch = async (options) => {
    calls.push(options);
    return typeof outcome === "function" ? outcome(options) : outcome;
  };
  return { calls, dispatch };
}

const throwing: Dispatch = async () => {
  throw new Error("sandbox unavailable");
};

const eventRow = (db: FakeDb, id: string) => db.tables.agent_events!.find((event) => event.id === id)!;

async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 0));
}

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { promise, open };
}

describe("event inbox drain", () => {
  it("runs one group's events in one dispatch, oldest first, and marks them done", async () => {
    const { db, client } = setup([webhook("e1", KEY, 1), webhook("e2", KEY, 2)]);
    const { calls, dispatch } = recorder(started("run-1"));

    await drain(client, dispatch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "github.push", firstEventId: "e1", concurrencyKey: KEY, eventIds: ["e1", "e2"] });
    expect(calls[0]!.events?.map((event) => event.eventId)).toEqual(["evt-e1", "evt-e2"]);
    expect(eventRow(db, "e1")).toMatchObject({ status: "done", claimed_by_run_id: "run-1" });
    expect(eventRow(db, "e2")).toMatchObject({ status: "done", claimed_by_run_id: "run-1" });
    expect(db.tables.agent_run_events!.map((link) => [link.agent_run_id, link.agent_event_id])).toEqual([
      ["run-1", "e1"],
      ["run-1", "e2"],
    ]);
  });

  it("leaves a group pending, with its attempt given back, while its routine has a live run", async () => {
    const live = { id: "live-1", workspace_id: WS, scheduled_task_id: TASK, concurrency_key: KEY, status: "live" };
    const { db, client } = setup([webhook("e1", KEY, 1)], { sessions: [live] });
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls).toHaveLength(0);
    expect(eventRow(db, "e1")).toMatchObject({ status: "pending", attempts: 0, lease_until: null });
  });

  it("dispatches each concurrency key on its own", async () => {
    const { db, client } = setup([webhook("e1", "github:org/a#1", 1), webhook("e2", "github:org/b#2", 2)]);
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls.map((call) => call.concurrencyKey).sort()).toEqual(["github:org/a#1", "github:org/b#2"]);
    expect(calls.every((call) => call.eventIds?.length === 1)).toBe(true);
    expect(eventRow(db, "e1").status).toBe("done");
    expect(eventRow(db, "e2").status).toBe("done");
  });

  it("coalesces several timers into one run at the newest occurrence", async () => {
    const { db, client } = setup([timer("t1", 1), timer("t2", 2), timer("t3", 3)]);
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "timer", occurrenceAt: at(3), eventIds: ["t3"] });
    expect(eventRow(db, "t1")).toMatchObject({ status: "skipped", failure_code: "timer_coalesced" });
    expect(eventRow(db, "t2")).toMatchObject({ status: "skipped", failure_code: "timer_coalesced" });
    expect(eventRow(db, "t3")).toMatchObject({ status: "done" });
  });

  it("runs at most EVENTS_PER_RUN of a group's events, oldest first, and leaves the rest pending", async () => {
    const ids = Array.from({ length: EVENTS_PER_RUN + 1 }, (_, index) => `e${index}`);
    const { db, client } = setup(ids.map((id, index) => webhook(id, KEY, index + 1)));
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls[0]!.eventIds).toEqual(ids.slice(0, EVENTS_PER_RUN));
    expect(eventRow(db, `e${EVENTS_PER_RUN}`)).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("returns an event to pending when its dispatch throws before the last attempt, and records the error", async () => {
    const { db, client } = setup([webhook("e1", KEY, 1)]);

    await drain(client, throwing);

    expect(eventRow(db, "e1")).toMatchObject({ status: "pending", attempts: 1, lease_until: null, failure_code: "dispatch_error" });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ scheduled_task_id: TASK, detail_json: { code: "agent_event_dispatch_failed" } });
  });

  it("releases its claimed events and throws when the drain can't load its dependencies", async () => {
    const { db, client } = setup([webhook("e1", KEY, 1)]);
    const broken = { client, now: () => new Date(), dispatch: undefined as never, get config(): never { throw new Error("no sandbox env"); } };

    await expect(drainEventInbox(broken)).rejects.toThrow("no sandbox env");

    expect(eventRow(db, "e1")).toMatchObject({ status: "pending", attempts: 0, lease_until: null });
  });

  it("marks an event dead when its dispatch throws on the last attempt, and records the error", async () => {
    const { db, client } = setup([webhook("e1", KEY, 1, { attempts: EVENT_MAX_ATTEMPTS - 1 })]);

    await drain(client, throwing);

    expect(eventRow(db, "e1")).toMatchObject({ status: "dead", failure_code: "dispatch_error", attempts: EVENT_MAX_ATTEMPTS });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({
      workspace_id: WS,
      scheduled_task_id: TASK,
      operation: "scheduling",
      detail_json: { code: "agent_event_dead" },
    });
  });

  it("releases a group when its dispatch reports busy, with the attempt given back", async () => {
    const { db, client } = setup([webhook("e1", KEY, 1)]);
    const { dispatch } = recorder({ status: "busy", sessionId: "s-live" });

    await drain(client, dispatch);

    expect(eventRow(db, "e1")).toMatchObject({ status: "pending", attempts: 0, lease_until: null });
  });

  it("runs a manual event on a paused routine", async () => {
    const { db, client } = setup([manual("m1", 1)], { tasks: [task({ enabled: false })] });
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "manual", manual: { requestedBy: "user-1" } });
    expect(eventRow(db, "m1")).toMatchObject({ status: "done" });
  });

  it("skips a timer on a paused routine without dispatching", async () => {
    const { db, client } = setup([timer("t1", 1)], { tasks: [task({ enabled: false })] });
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls).toHaveLength(0);
    expect(eventRow(db, "t1")).toMatchObject({ status: "skipped", failure_code: "routine_disabled" });
  });

  it("still runs a one-shot's timer, although its claim paused the routine", async () => {
    const oneShot = task({ enabled: false, schedule_kind: "once", fired_at: at(1) });
    const { db, client } = setup([timer("t1", 1)], { tasks: [oneShot] });
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "timer" });
    expect(eventRow(db, "t1")).toMatchObject({ status: "done" });
  });

  it("skips the events of a deleted routine", async () => {
    const { db, client } = setup([webhook("e1", KEY, 1)], { tasks: [task({ deleted_at: at(0) })] });
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls).toHaveLength(0);
    expect(eventRow(db, "e1")).toMatchObject({ status: "skipped", failure_code: "routine_deleted" });
  });

  it("dispatches a hidden webhook with its skip note, then marks the event skipped", async () => {
    const skip = { code: "routine_source_not_visible", note: "Skipped: a private item." };
    const { db, client } = setup([hidden("h1", 1, skip)]);
    const { calls, dispatch } = recorder();

    await drain(client, dispatch);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ skip, concurrencyKey: null, firstEventId: "h1", kind: "github.push" });
    expect(calls[0]!.events).toHaveLength(1);
    expect(eventRow(db, "h1")).toMatchObject({ status: "skipped", failure_code: skip.code });
  });

  it("shares a drain with a call made during it, runs one more pass, and never runs two drains at once", async () => {
    const { db, client } = setup([webhook("e1", "k-1", 1)]);
    const release = gate();
    const seen: string[] = [];
    let active = 0;
    let peak = 0;
    const dispatch: Dispatch = async (options) => {
      active += 1;
      peak = Math.max(peak, active);
      seen.push(options.firstEventId);
      if (seen.length === 1) await release.promise;
      active -= 1;
      return started(`run-${seen.length}`);
    };

    const first = drain(client, dispatch);
    await until(() => seen.length === 1);
    db.tables.agent_events!.push(webhook("e2", "k-2", 2));
    const second = drain(client, dispatch);
    expect(second).toBe(first);

    release.open();
    await second;

    expect(seen).toEqual(["e1", "e2"]);
    expect(peak).toBe(1);
    expect(db.rpcCalls.filter((call) => call.name === "claim_agent_events")).toHaveLength(2);
  });

  it("records a group that throws, leaves its events claimed, and still runs the other groups", async () => {
    const { db, client } = setup([webhook("e1", "k-1", 1), webhook("e2", "k-2", 2)]);
    let clockReads = 0;
    // The first clock read happens inside the first group, so only that group fails.
    const now = () => {
      clockReads += 1;
      if (clockReads === 1) throw new Error("clock");
      return NOW;
    };
    const { calls, dispatch } = recorder();

    await drain(client, dispatch, now);

    expect(calls.map((call) => call.firstEventId)).toEqual(["e2"]);
    expect(eventRow(db, "e1")).toMatchObject({ status: "claimed" });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({ detail_json: { code: "event_group_failed" } });
  });
});
