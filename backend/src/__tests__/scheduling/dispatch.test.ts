import { describe, expect, it, mock } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { dispatchScheduledTask, type DispatchDependencies } from "../../scheduling/dispatch";
import type { ScheduledTaskRow } from "../../types/tables";

function baseTask(overrides: Partial<ScheduledTaskRow>): ScheduledTaskRow {
  return {
    id: "task-1",
    workspace_id: "workspace-1",
    source_connection_id: null,
    task_type: "synthesize_workspace",
    task_key: "test",
    schedule_kind: "cron",
    cron_expression: "0 0 8 * * *",
    interval_seconds: null,
    timezone: "UTC",
    enabled: true,
    config_json: {},
    next_due_at: "2026-08-05T08:00:00.000Z",
    last_enqueued_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeClient(scheduledTaskRow: ScheduledTaskRow | null, connectionRow?: Record<string, unknown>) {
  const client = {
    from: (table: string) => {
      if (table === "scheduled_tasks") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: scheduledTaskRow, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === "source_connections") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({ data: connectionRow, error: null }),
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return client;
}

function neverCalledDeps(): DispatchDependencies {
  const shouldNotBeCalled = () => {
    throw new Error("should not be called");
  };
  return {
    reconcileFirefliesConnection: mock(shouldNotBeCalled) as unknown as DispatchDependencies["reconcileFirefliesConnection"],
    materializeSlackBatches: mock(shouldNotBeCalled) as unknown as DispatchDependencies["materializeSlackBatches"],
    launchSynthesisRun: mock(shouldNotBeCalled) as unknown as DispatchDependencies["launchSynthesisRun"],
    getReadySourceItemIds: mock(shouldNotBeCalled) as unknown as DispatchDependencies["getReadySourceItemIds"],
    launchSummarizationBatch: mock(shouldNotBeCalled) as unknown as DispatchDependencies["launchSummarizationBatch"],
  };
}

const fakeConfig = {} as never;

describe("dispatchScheduledTask", () => {
  it("no-ops when the fresh task row is no longer enabled", async () => {
    const task = baseTask({ task_type: "synthesize_workspace" });
    const client = fakeClient({ ...task, enabled: false });
    const deps = neverCalledDeps();

    await dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps);

    expect(deps.launchSynthesisRun).not.toHaveBeenCalled();
  });

  it("no-ops when the task row no longer exists", async () => {
    const task = baseTask({ task_type: "synthesize_workspace" });
    const client = fakeClient(null);
    const deps = neverCalledDeps();

    await dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps);

    expect(deps.launchSynthesisRun).not.toHaveBeenCalled();
  });

  it("rejects an unsupported task_type rather than silently no-op'ing", async () => {
    const task = baseTask({ task_type: "rebuild_projection" as ScheduledTaskRow["task_type"] });
    const client = fakeClient(task);
    const deps = neverCalledDeps();

    await expect(
      dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps),
    ).rejects.toThrow(/Unsupported scheduled task_type/);
  });

  it("routes ingest_source to the Fireflies handler based on connection provider", async () => {
    const task = baseTask({
      task_type: "ingest_source",
      source_connection_id: "conn-1",
      schedule_kind: "interval",
      cron_expression: null,
      interval_seconds: 900,
    });
    const client = fakeClient(task, {
      id: "conn-1",
      workspace_id: task.workspace_id,
      provider: "fireflies",
      cursor_json: {},
    });
    const deps = neverCalledDeps();
    deps.reconcileFirefliesConnection = mock(async () => ({ ingested: 1 })) as unknown as DispatchDependencies["reconcileFirefliesConnection"];

    await dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps);

    expect(deps.reconcileFirefliesConnection).toHaveBeenCalledTimes(1);
    expect(deps.materializeSlackBatches).not.toHaveBeenCalled();
  });

  it("routes ingest_source to the Slack handler based on connection provider", async () => {
    const task = baseTask({
      task_type: "ingest_source",
      source_connection_id: "conn-2",
      schedule_kind: "interval",
      cron_expression: null,
      interval_seconds: 300,
    });
    const client = fakeClient(task, {
      id: "conn-2",
      workspace_id: task.workspace_id,
      provider: "slack",
      cursor_json: {},
    });
    const deps = neverCalledDeps();
    deps.materializeSlackBatches = mock(async () => ({ batchesCut: 0, updatedCursorJson: {} })) as unknown as DispatchDependencies["materializeSlackBatches"];

    await dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps);

    expect(deps.materializeSlackBatches).toHaveBeenCalledTimes(1);
    expect(deps.reconcileFirefliesConnection).not.toHaveBeenCalled();
  });

  it("propagates an ingestion failure without retrying -- the next scheduled occurrence retries instead", async () => {
    const task = baseTask({
      task_type: "ingest_source",
      source_connection_id: "conn-1",
      schedule_kind: "interval",
      cron_expression: null,
      interval_seconds: 900,
    });
    const client = fakeClient(task, {
      id: "conn-1",
      workspace_id: task.workspace_id,
      provider: "fireflies",
      cursor_json: {},
    });
    const deps = neverCalledDeps();
    let calls = 0;
    deps.reconcileFirefliesConnection = mock(async () => {
      calls += 1;
      throw new Error("transient");
    }) as unknown as DispatchDependencies["reconcileFirefliesConnection"];

    await expect(
      dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps),
    ).rejects.toThrow("transient");

    expect(calls).toBe(1);
  });

  it("no-ops a synthesize_workspace dispatch when there are no ready source items", async () => {
    const task = baseTask({ task_type: "synthesize_workspace" });
    const client = fakeClient(task);
    const deps = neverCalledDeps();
    deps.getReadySourceItemIds = mock(async () => []) as unknown as DispatchDependencies["getReadySourceItemIds"];

    await dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps);

    expect(deps.launchSynthesisRun).not.toHaveBeenCalled();
  });

  it("launches synthesis with the occurrence-derived options when ready items exist", async () => {
    const task = baseTask({ task_type: "synthesize_workspace" });
    const client = fakeClient(task);
    const deps = neverCalledDeps();
    deps.getReadySourceItemIds = mock(async () => ["item-1", "item-2"]) as unknown as DispatchDependencies["getReadySourceItemIds"];
    deps.launchSynthesisRun = mock(async () => ({
      runId: "run-1",
      machineId: "machine-1",
      bundleHash: "hash",
    })) as unknown as DispatchDependencies["launchSynthesisRun"];

    await dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps);

    expect(deps.launchSynthesisRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: task.workspace_id,
        triggerType: "schedule",
        sourceItemIds: ["item-1", "item-2"],
        scheduledTaskId: task.id,
        occurrenceAt: task.next_due_at,
      }),
    );
  });

  it("routes summarize_sessions to the summarization batch launcher", async () => {
    const task = baseTask({ task_type: "summarize_sessions" });
    const client = fakeClient(task);
    const deps = neverCalledDeps();
    deps.launchSummarizationBatch = mock(async () => null) as unknown as DispatchDependencies["launchSummarizationBatch"];

    await dispatchScheduledTask({ task, occurrenceAt: task.next_due_at!, config: fakeConfig, client }, deps);

    expect(deps.launchSummarizationBatch).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: task.workspace_id }),
    );
  });
});
