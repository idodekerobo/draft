import { describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSchedulingTick } from "../../scheduling/tick";
import type { expireIdleCloudSessions } from "../../cloud-sessions/expire";
import type { SandboxDeploymentConfig } from "../../metaharness/sandbox";
import type { ScheduledTaskRow } from "../../types/tables";
import { createFakeRunsClient, fakeRun } from "../synthesis/fake-runs-client";

const NOW = "2026-08-05T10:00:30.000Z";
const OCCURRENCE = "2026-08-05T10:00:00.000Z";
// What claim_due_scheduled_tasks writes into next_due_at for a recurring row: now + 5 minutes.
const LEASE = "2026-08-05T10:05:30.000Z";

const SANDBOX: SandboxDeploymentConfig = {
  callbackUrl: "https://api.draft.test/sandbox/callback",
  callbackSecret: "callback-secret",
  supabaseUrl: "https://project.supabase.co",
  provider: { kind: "fly", apiToken: "fly-token", appName: "draft-sandbox", image: `registry.fly.io/draft-sandbox@sha256:${"a".repeat(64)}`, region: "iad" },
};

function task(overrides: Partial<ScheduledTaskRow>): ScheduledTaskRow {
  return {
    id: "task-1",
    workspace_id: "workspace-1",
    connection_id: null,
    task_type: "synthesize_workspace",
    task_key: "test",
    schedule_kind: "interval",
    cron_expression: null,
    interval_seconds: 300,
    timezone: "UTC",
    enabled: true,
    config_json: {},
    next_due_at: OCCURRENCE,
    deleted_at: null,
    last_enqueued_at: null,
    claimed_occurrence_at: null,
    run_at: null,
    fired_at: null,
    created_via: "system",
    created_by_run_id: null,
    trigger_depth: 0,
    visibility: "shared",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    updated_by_user_id: null,
    created_by_user_id: null,
    ...overrides,
  };
}

interface ClaimedRow {
  task: ScheduledTaskRow;
  occurrence_at: string;
}

// Mirrors a claim_due_scheduled_tasks row: the task is returned after the claim's update.
function claimed(overrides: Partial<ScheduledTaskRow>, occurrenceAt = OCCURRENCE): ClaimedRow {
  return { task: task({ next_due_at: LEASE, ...overrides }), occurrence_at: occurrenceAt };
}

interface FakeClientOptions {
  claimed?: ClaimedRow[];
  failSynthesisRuns?: boolean;
  failSweep?: boolean;
  failUpdateFor?: string[];
  trace?: string[];
}

function fakeClient(options: FakeClientOptions = {}) {
  const rpcCalls: { name: string; args?: Record<string, unknown> }[] = [];
  const updates: { payload: Record<string, unknown>; filters: Record<string, unknown> }[] = [];
  const errorInserts: Record<string, unknown>[] = [];
  const runsClient = createFakeRunsClient({ agent_runs: [] }).client;

  const client = {
    rpc: async (name: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      options.trace?.push(`rpc:${name}`);
      if (name === "claim_due_scheduled_tasks") return { data: options.claimed ?? [], error: null };
      return { data: 0, error: options.failSweep ? new Error("sweep down") : null };
    },
    from: (table: string) => {
      if (table === "scheduled_tasks") {
        return {
          update: (payload: Record<string, unknown>) => ({
            eq: (idColumn: string, id: string) => ({
              eq: (workspaceColumn: string, workspaceId: string) => ({
                eq: async (guardColumn: string, guardValue: unknown) => {
                  updates.push({
                    payload,
                    filters: { [idColumn]: id, [workspaceColumn]: workspaceId, [guardColumn]: guardValue },
                  });
                  return { data: null, error: options.failUpdateFor?.includes(id) ? new Error("update down") : null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "agent_runs") {
        if (options.failSynthesisRuns) throw new Error("db down");
        return runsClient.from(table);
      }
      if (table === "errors") {
        return {
          insert: async (payload: Record<string, unknown>) => {
            errorInserts.push(payload);
            return { data: null, error: null };
          },
        };
      }
      if (table === "sessions") {
        const chain = {
          eq: () => chain,
          in: () => chain,
          lt: async () => ({ data: [], error: null }),
        };
        return { select: () => chain };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;

  return { client, updates, errorInserts, rpcCalls };
}

const fakeConfig = {} as never;
const now = new Date(NOW);

describe("runSchedulingTick", () => {
  it("claims due timers with the tick's clock and the lease length", async () => {
    const { client, rpcCalls } = fakeClient();

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch: mock(async () => null), drain: mock(async () => {}) });

    expect(rpcCalls[0]).toEqual({
      name: "claim_due_scheduled_tasks",
      args: { p_now: NOW, p_limit: 100, p_lease_seconds: 300 },
    });
  });

  it("dispatches a system task, advances a cron routine without dispatching it, and skips a once routine", async () => {
    const systemRow = claimed({ id: "system-task" });
    const cronRow = claimed({
      id: "routine-cron",
      task_type: "agent_routine",
      created_via: "app",
      schedule_kind: "cron",
      cron_expression: "0 * * * *",
      interval_seconds: null,
    });
    const onceRow = claimed({
      id: "routine-once",
      task_type: "agent_routine",
      created_via: "app",
      schedule_kind: "once",
      cron_expression: null,
      interval_seconds: null,
      run_at: OCCURRENCE,
      fired_at: NOW,
      enabled: false,
      next_due_at: null,
    });
    const dispatch = mock(async () => null);
    const drain = mock(async () => {});
    const { client, updates } = fakeClient({ claimed: [systemRow, cronRow, onceRow] });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch, drain });

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ task: systemRow.task, occurrenceAt: OCCURRENCE }));
    expect(drain).toHaveBeenCalledTimes(1);
    // Each advance computes from the occurrence, not the lease, and is guarded on the lease.
    expect(updates).toEqual([
      {
        payload: { next_due_at: "2026-08-05T10:05:00.000Z", claimed_occurrence_at: null },
        filters: { id: "system-task", workspace_id: "workspace-1", next_due_at: LEASE },
      },
      {
        payload: { next_due_at: "2026-08-05T11:00:00.000Z", claimed_occurrence_at: null },
        filters: { id: "routine-cron", workspace_id: "workspace-1", next_due_at: LEASE },
      },
    ]);
  });

  it("logs to errors and still advances next_due_at when dispatch throws", async () => {
    const dispatch = mock(async () => {
      throw new Error("boom");
    });
    const { client, updates, errorInserts } = fakeClient({ claimed: [claimed({ id: "task-b" })] });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch, drain: mock(async () => {}) });

    expect(errorInserts).toHaveLength(1);
    expect(errorInserts[0]).toMatchObject({
      workspace_id: "workspace-1",
      scheduled_task_id: "task-b",
      operation: "scheduling",
    });
    expect(errorInserts[0].detail_json).toMatchObject({ code: "scheduled_task_dispatch_failed" });
    // Still advances -- a persistently failing task must retry at its next
    // natural occurrence, not spin every tick.
    expect(updates).toHaveLength(1);
  });

  it("captures a useful message when dispatch throws a non-Error (e.g. a PostgrestError-shaped object)", async () => {
    const dispatch = mock(async () => {
      throw { message: "duplicate key value violates unique constraint", code: "23505" };
    });
    const { client, errorInserts } = fakeClient({ claimed: [claimed({ id: "task-c" })] });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch, drain: mock(async () => {}) });

    expect(errorInserts[0].detail_json).toMatchObject({
      error: { message: "duplicate key value violates unique constraint", code: "23505" },
    });
  });

  it("processes remaining claimed tasks even after an earlier one fails", async () => {
    const dispatch = mock(async (options: { task: ScheduledTaskRow }) => {
      if (options.task.id === "task-fail") throw new Error("boom");
      return null;
    });
    const { client, updates } = fakeClient({ claimed: [claimed({ id: "task-fail" }), claimed({ id: "task-ok" })] });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch, drain: mock(async () => {}) });

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(updates.map((u) => u.filters.id)).toEqual(["task-fail", "task-ok"]);
  });

  it("advances from the schedule dispatch actually saw, not the claimed copy", async () => {
    // Fresh row (dispatch's refetch) has interval_seconds=60; the claimed copy still says 300.
    const staleRow = claimed({ id: "task-a", interval_seconds: 300 });
    const freshTask = task({ id: "task-a", interval_seconds: 60, next_due_at: LEASE });
    const dispatch = mock(async () => freshTask);
    const { client, updates } = fakeClient({ claimed: [staleRow] });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch, drain: mock(async () => {}) });

    // 60s from the occurrence (10:00:00) -> 10:01:00, not the stale 300s or the lease.
    expect(updates[0].payload.next_due_at).toBe(new Date("2026-08-05T10:01:00.000Z").toISOString());
  });

  it("does nothing with dispatch when no timers are claimed", async () => {
    const dispatch = mock(async () => null);
    const { client, updates } = fakeClient({ claimed: [] });

    await runSchedulingTick({ client, config: fakeConfig, now: new Date(), dispatch, drain: mock(async () => {}) });

    expect(dispatch).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("sweeps stale runs from the tick, with no workspace filter", async () => {
    const dispatch = mock(async () => null);
    const { client: runsClient, runs } = createFakeRunsClient({
      agent_runs: [
        fakeRun({
          id: "stuck",
          workspace_id: "workspace-z",
          status: "running",
          created_at: new Date(Date.now() - 60 * 60_000).toISOString(),
        }),
      ],
    });
    const { client } = fakeClient();
    const wrapped = {
      rpc: client.rpc,
      from: (table: string) => (table === "agent_runs" ? runsClient.from(table) : client.from(table)),
    } as unknown as SupabaseClient;

    await runSchedulingTick({ client: wrapped, config: fakeConfig, now: new Date(), dispatch, drain: mock(async () => {}) });

    expect(runs[0].status).toBe("failed");
  });

  it("still advances tasks when the sweep and retry steps fail", async () => {
    const dispatch = mock(async () => null);
    const { client, updates } = fakeClient({ claimed: [claimed({ id: "task-a" })], failSynthesisRuns: true });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch, drain: mock(async () => {}) });

    expect(updates).toHaveLength(1);
  });

  it("writes only next_due_at, guarded on the lease the claim wrote, so an edit made mid-dispatch survives", async () => {
    const dueRow = claimed({ id: "task-a", schedule_kind: "cron", cron_expression: "0 * * * *", interval_seconds: null });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = mock(async () => {
      await gate;
      return dueRow.task;
    });
    const { client, updates } = fakeClient({ claimed: [dueRow] });

    const tick = runSchedulingTick({ client, config: fakeConfig, now, dispatch, drain: mock(async () => {}) });
    // A member edit lands here, between dispatch's read and the advance write.
    release();
    await tick;

    expect(Object.keys(updates[0]!.payload).sort()).toEqual(["claimed_occurrence_at", "next_due_at"]);
    expect(updates[0]!.filters.next_due_at).toBe(LEASE);
  });

  it("records a failed advance and still advances the rest of the claimed batch", async () => {
    const { client, updates, errorInserts } = fakeClient({
      claimed: [claimed({ id: "task-x" }), claimed({ id: "task-y" })],
      failUpdateFor: ["task-x"],
    });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch: mock(async () => null), drain: mock(async () => {}) });

    expect(updates.map((u) => u.filters.id)).toEqual(["task-x", "task-y"]);
    expect(errorInserts).toHaveLength(1);
    expect(errorInserts[0]).toMatchObject({ scheduled_task_id: "task-x" });
    expect(errorInserts[0].detail_json).toMatchObject({ code: "scheduled_task_advance_failed" });
  });

  it("drains the event inbox once, after the claimed batch and before the sweeps", async () => {
    const trace: string[] = [];
    const dispatch = mock(async () => {
      trace.push("dispatch");
      return null;
    });
    const drain = mock(async () => {
      trace.push("drain");
    });
    const { client } = fakeClient({ claimed: [claimed({ id: "task-a" })], trace });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch, drain });

    expect(drain).toHaveBeenCalledTimes(1);
    expect(trace).toEqual(["rpc:claim_due_scheduled_tasks", "dispatch", "drain", "rpc:sweep_stale_sessions"]);
  });

  it("keeps running the sweeps when the drain fails", async () => {
    const trace: string[] = [];
    const drain = mock(async () => {
      throw new Error("drain down");
    });
    const { client } = fakeClient({ trace });

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch: mock(async () => null), drain });

    expect(trace).toContain("rpc:sweep_stale_sessions");
  });

  it("marks stale live sessions offline on every tick", async () => {
    const { client, rpcCalls } = fakeClient();
    await runSchedulingTick({ client, config: fakeConfig, now, dispatch: mock(async () => null), drain: mock(async () => {}) });
    expect(rpcCalls.map((call) => call.name)).toEqual(["claim_due_scheduled_tasks", "sweep_stale_sessions"]);
  });

  it("still advances tasks when the session sweep fails", async () => {
    const { client, updates } = fakeClient({ claimed: [claimed({ id: "task-a" })], failSweep: true });
    await runSchedulingTick({ client, config: fakeConfig, now, dispatch: mock(async () => null), drain: mock(async () => {}) });
    expect(updates).toHaveLength(1);
  });

  it("expires idle cloud sessions on every tick, with the provider from its sandbox config", async () => {
    const expire = mock(async (_options: Parameters<typeof expireIdleCloudSessions>[0]) => ({ expired: 0, skipped: 0, failed: 0 }));
    const { client } = fakeClient();

    await runSchedulingTick({ client, config: SANDBOX, now, dispatch: mock(async () => null), drain: mock(async () => {}), expire });

    expect(expire).toHaveBeenCalledTimes(1);
    const options = expire.mock.calls[0]![0];
    expect(options.client).toBe(client);
    expect(options.provider).toEqual(expect.objectContaining({ destroy: expect.any(Function) }));
    expect(options.now?.()).toEqual(now);
  });

  it("skips the expiry when no sandbox settings are passed", async () => {
    const expire = mock(async (_options: Parameters<typeof expireIdleCloudSessions>[0]) => ({ expired: 0, skipped: 0, failed: 0 }));
    const { client, errorInserts } = fakeClient();

    await runSchedulingTick({ client, config: fakeConfig, now, dispatch: mock(async () => null), drain: mock(async () => {}), expire });

    expect(expire).not.toHaveBeenCalled();
    expect(errorInserts).toHaveLength(0);
  });

  it("keeps the rest of the tick running when the expiry throws", async () => {
    const expire = mock(async (_options: Parameters<typeof expireIdleCloudSessions>[0]): Promise<never> => {
      throw new Error("expiry down");
    });
    const { client, updates } = fakeClient({ claimed: [claimed({ id: "task-a" })] });

    await runSchedulingTick({ client, config: SANDBOX, now, dispatch: mock(async () => null), drain: mock(async () => {}), expire });

    expect(expire).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
  });
});
