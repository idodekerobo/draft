import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { __resetDrainForTests, drainEventInbox } from "../../events/drain";
import type { dispatchAgentRoutine } from "../../routines/dispatch-routine";
import type { SandboxDeploymentConfig } from "../../sandbox";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

mock.module("../../db/client", () => ({ serviceClient: fakeClient(fakeDb()) }));
const { runRoutineNow } = await import("../../schedules/service");

type Dispatch = typeof dispatchAgentRoutine;
type Outcome = Awaited<ReturnType<Dispatch>>;
type Row = Record<string, unknown>;

const WS = "ws-1";
const TASK = "task-1";
const USER = "user-1";
const CONFIG = {} as SandboxDeploymentConfig;
const NOW = new Date("2026-11-16T12:00:00.000Z");

beforeEach(() => __resetDrainForTests());

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

function setup(options: { sessions?: Row[]; agentRuns?: Row[] } = {}) {
  const db = fakeDb(
    {
      scheduled_tasks: [
        {
          id: TASK,
          workspace_id: WS,
          task_type: "agent_routine",
          schedule_kind: "cron",
          enabled: true,
          deleted_at: null,
          fired_at: null,
          created_by_user_id: USER,
          timezone: "UTC",
          source_connection_id: null,
          config_json: { title: "Digest", prompt: "Summarize the week.", harness: "claude", model: "haiku" },
        },
      ],
      agent_events: [],
      agent_runs: options.agentRuns ?? [],
      sessions: options.sessions ?? [],
      agent_run_events: [],
      errors: [],
    },
    {
      unique: { agent_events: [["workspace_id", "dedupe_key"]] },
      uuidTables: ["agent_events"],
      defaults: { agent_events: { status: "pending", attempts: 0, claimed_by_run_id: null, failure_code: null, created_at: NOW.toISOString() } },
    },
  );
  db.rpcs.claim_agent_events = claimPending(db);
  return { db, client: fakeClient(db) };
}

function recorder(outcome: Outcome) {
  const calls: Parameters<Dispatch>[0][] = [];
  const dispatch: Dispatch = async (options) => {
    calls.push(options);
    return outcome;
  };
  return { calls, dispatch };
}

/** The real drain, with the given dispatch in place of the sandbox. */
const drainWith = (client: SupabaseClient, dispatch: Dispatch) => () => drainEventInbox({ client, config: CONFIG, dispatch, now: () => NOW });

describe("runRoutineNow", () => {
  it("queues a manual event, drains it, and reports the run it started", async () => {
    const { db, client } = setup({ agentRuns: [{ id: "run-1", session_id: "s-1", workspace_id: WS }] });
    const { calls, dispatch } = recorder({ status: "started", sessionId: "s-1", runId: "run-1" });

    const outcome = await runRoutineNow(WS, TASK, USER, { client, drain: drainWith(client, dispatch) });

    expect(outcome).toEqual({ status: "started", runId: "run-1", sessionId: "s-1" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: "manual", concurrencyKey: TASK, manual: { requestedBy: USER } });
    expect(db.tables.agent_events![0]).toMatchObject({
      origin: "manual",
      event_name: "manual",
      concurrency_key: TASK,
      status: "done",
      claimed_by_run_id: "run-1",
      payload: { type: "manual", requestedBy: USER },
    });
    expect(String(db.tables.agent_events![0]!.dedupe_key)).toMatch(new RegExp(`^${TASK}:manual:`));
    expect(db.tables.errors).toHaveLength(0);
  });

  it("queues the run behind a run that is still live, and dispatches nothing", async () => {
    const { db, client } = setup({
      sessions: [{ id: "s-live", workspace_id: WS, scheduled_task_id: TASK, concurrency_key: TASK, status: "live" }],
    });
    const { calls, dispatch } = recorder({ status: "started", sessionId: "s-2", runId: "run-2" });

    const outcome = await runRoutineNow(WS, TASK, USER, { client, drain: drainWith(client, dispatch) });

    expect(outcome).toEqual({ status: "queued" });
    expect(calls).toHaveLength(0);
    expect(db.tables.agent_events![0]).toMatchObject({ status: "pending" });
    expect(db.tables.errors).toHaveLength(0);
  });

  it("records a failed drain, and still reports where the run stands", async () => {
    const { db, client } = setup();

    const outcome = await runRoutineNow(WS, TASK, USER, {
      client,
      drain: async () => {
        throw new Error("drain down");
      },
    });

    expect(outcome).toEqual({ status: "queued" });
    expect(db.tables.errors).toHaveLength(1);
    expect(db.tables.errors![0]).toMatchObject({
      workspace_id: WS,
      scheduled_task_id: TASK,
      operation: "scheduling",
      detail_json: { code: "event_drain_failed", event_id: db.tables.agent_events![0]!.id },
    });
  });

  it("reports a failed dispatch with its code, and records nothing more for it", async () => {
    const { db, client } = setup();
    const { dispatch } = recorder({ status: "failed", sessionId: "s-1", code: "routine_launch_failed" });

    const outcome = await runRoutineNow(WS, TASK, USER, { client, drain: drainWith(client, dispatch) });

    expect(outcome).toEqual({ status: "failed", code: "routine_launch_failed" });
    expect(db.tables.agent_events![0]).toMatchObject({ status: "failed", failure_code: "routine_launch_failed" });
    expect(db.tables.errors).toHaveLength(0);
  });

  it("records a failed enqueue, reports it as failed, and dispatches nothing", async () => {
    const { db, client } = setup();
    const { calls, dispatch } = recorder({ status: "started", sessionId: "s-1", runId: "run-1" });

    const outcome = await runRoutineNow(WS, TASK, USER, {
      client,
      enqueue: async () => {
        throw new Error("insert down");
      },
      drain: drainWith(client, dispatch),
    });

    expect(outcome).toEqual({ status: "failed", code: "event_enqueue_failed" });
    expect(calls).toHaveLength(0);
    expect(db.tables.errors).toEqual([
      expect.objectContaining({ operation: "scheduling", detail_json: expect.objectContaining({ code: "event_enqueue_failed" }) }),
    ]);
  });

  it("records a started run whose session cannot be read, and names the run", async () => {
    const { db, client } = setup();
    const { dispatch } = recorder({ status: "started", sessionId: "s-1", runId: "run-1" });

    const outcome = await runRoutineNow(WS, TASK, USER, { client, drain: drainWith(client, dispatch) });

    expect(outcome).toEqual({ status: "failed", code: "run_lookup_failed" });
    expect(db.tables.errors).toEqual([
      expect.objectContaining({ agent_run_id: "run-1", detail_json: expect.objectContaining({ code: "run_lookup_failed" }) }),
    ]);
  });

  it("refuses an unknown routine without queuing anything", async () => {
    const { db, client } = setup();

    await expect(runRoutineNow(WS, "missing", USER, { client, drain: async () => {} })).rejects.toThrow("not_found");
    expect(db.tables.agent_events).toHaveLength(0);
  });
});
