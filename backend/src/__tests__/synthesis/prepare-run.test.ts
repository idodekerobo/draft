import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  markRunLaunched,
  prepareRun,
  WorkspaceRunAlreadyActiveError,
} from "../../synthesis/prepare-run";
import type { FlySandboxRunReceipt } from "../../sandbox";

const ids = {
  workspace: "33333333-3333-4333-8333-333333333333",
  version: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  scheduledTask: "77777777-7777-4777-8777-777777777777",
  sourceA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

interface FakeClientOptions {
  currentContextVersionId?: string | null;
  sourceItems?: Array<{ id: string; external_version: string; content_hash: string | null }>;
  runInsertError?: { message: string; code: string };
  membershipInsertError?: Error;
}

/**
 * Fake Supabase client for prepare-run.ts's insert/update/select chains.
 * Records call order so tests can assert the sweep runs before the insert.
 */
function createFakeClient(options: FakeClientOptions = {}) {
  const calls: {
    order: string[];
    runInserts: Record<string, unknown>[];
    membershipInserts: Record<string, unknown>[];
    updates: Array<{ table: string; payload: Record<string, unknown>; id: string }>;
  } = { order: [], runInserts: [], membershipInserts: [], updates: [] };

  const currentContextVersionId =
    options.currentContextVersionId === undefined
      ? ids.version
      : options.currentContextVersionId;
  const sourceItems = options.sourceItems ?? [];

  // Stand-in for the sweep's select query; always resolves to no stale
  // candidates (sweep behavior itself is covered by reconcile-stale-runs.test.ts).
  function emptySweepSelectResult() {
    const result = {
      eq: () => result,
      then: (resolve: (value: { data: unknown[]; error: null }) => void) =>
        resolve({ data: [], error: null }),
    };
    return result;
  }

  function from(table: string) {
    if (table === "workspaces") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { current_context_version_id: currentContextVersionId },
              error: null,
            }),
          }),
        }),
      };
    }

    if (table === "source_items") {
      return {
        select: () => ({
          in: async (_column: string, values: string[]) => ({
            data: sourceItems.filter((item) => values.includes(item.id)),
            error: null,
          }),
        }),
      };
    }

    if (table === "synthesis_runs") {
      return {
        select: () => ({
          in: () => {
            calls.order.push("sweep-select");
            return { lt: () => emptySweepSelectResult() };
          },
        }),
        insert: (payload: Record<string, unknown>) => {
          calls.order.push("run-insert");
          calls.runInserts.push(payload);
          return {
            select: () => ({
              single: async () => {
                if (options.runInsertError) {
                  return { data: null, error: options.runInsertError };
                }
                return { data: { id: ids.run }, error: null };
              },
            }),
          };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async (_column: string, id: string) => {
            calls.updates.push({ table: "synthesis_runs", payload, id });
            return { data: null, error: null };
          },
        }),
      };
    }

    if (table === "synthesis_run_source_items") {
      return {
        insert: async (payload: Record<string, unknown>[]) => {
          calls.membershipInserts.push(...payload);
          if (options.membershipInsertError) {
            return { data: null, error: options.membershipInsertError };
          }
          return { data: null, error: null };
        },
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  const client = { from } as unknown as SupabaseClient;
  return { client, calls };
}

function fakeReceipt(): FlySandboxRunReceipt {
  return {
    machineId: "machine-1",
    state: "started",
    runId: ids.run,
    bundleHash: "hash-1",
    callbackExpiresAt: Date.now() + 60_000,
  };
}

describe("prepareRun", () => {
  it("uses {scheduled_task_id}:{occurrence_timestamp_utc} for scheduled runs", async () => {
    const { client, calls } = createFakeClient({ sourceItems: [] });

    await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "schedule",
      sourceItemIds: [],
      scheduledTaskId: ids.scheduledTask,
      client,
    });

    expect(calls.runInserts).toHaveLength(1);
    const insert = calls.runInserts[0];
    expect(insert.scheduled_task_id).toBe(ids.scheduledTask);
    const key = insert.idempotency_key as string;
    expect(key.startsWith(`${ids.scheduledTask}:`)).toBe(true);
    const timestampPart = key.slice(`${ids.scheduledTask}:`.length);
    expect(() => new Date(timestampPart).toISOString()).not.toThrow();
    expect(new Date(timestampPart).toISOString()).toBe(timestampPart);
  });

  it("uses {trigger_type}:{uuid} for manual/seed/other runs", async () => {
    const { client, calls } = createFakeClient({ sourceItems: [] });

    await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [],
      client,
    });

    const insert = calls.runInserts[0];
    expect(insert.scheduled_task_id).toBeNull();
    const key = insert.idempotency_key as string;
    expect(key.startsWith("manual:")).toBe(true);
    const uuidPart = key.slice("manual:".length);
    expect(uuidPart).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("throws when the workspace has no current_context_version_id", async () => {
    const { client } = createFakeClient({ currentContextVersionId: null });

    await expect(
      prepareRun({
        workspaceId: ids.workspace,
        triggerType: "manual",
        sourceItemIds: [],
        client,
      }),
    ).rejects.toThrow();
  });

  it("assigns position 0..n-1 to source items in the given order and pulls version/hash from source_items", async () => {
    const { client, calls } = createFakeClient({
      sourceItems: [
        { id: ids.sourceA, external_version: "3", content_hash: "hash-a" },
        { id: ids.sourceB, external_version: "7", content_hash: "hash-b" },
      ],
    });

    const runId = await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [ids.sourceB, ids.sourceA],
      client,
    });

    expect(runId).toBe(ids.run);
    expect(calls.membershipInserts).toHaveLength(2);
    expect(calls.membershipInserts[0]).toMatchObject({
      workspace_id: ids.workspace,
      synthesis_run_id: ids.run,
      source_item_id: ids.sourceB,
      position: 0,
      source_item_version: "7",
      content_hash: "hash-b",
    });
    expect(calls.membershipInserts[1]).toMatchObject({
      workspace_id: ids.workspace,
      synthesis_run_id: ids.run,
      source_item_id: ids.sourceA,
      position: 1,
      source_item_version: "3",
      content_hash: "hash-a",
    });
  });

  it("inserts the run row with status preparing and attempt 1", async () => {
    const { client, calls } = createFakeClient({ sourceItems: [] });

    await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "seed_test",
      sourceItemIds: [],
      client,
    });

    const insert = calls.runInserts[0];
    expect(insert.status).toBe("preparing");
    expect(insert.attempt).toBe(1);
    expect(insert.base_context_version_id).toBe(ids.version);
    expect(insert.workspace_id).toBe(ids.workspace);
    expect(typeof insert.prompt_version).toBe("string");
  });

  it("sweeps stale runs for the workspace before inserting the new run", async () => {
    const { client, calls } = createFakeClient({ sourceItems: [] });

    await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [],
      client,
    });

    expect(calls.order).toEqual(["sweep-select", "run-insert"]);
  });

  it("throws WorkspaceRunAlreadyActiveError when the insert hits the one-active-writer index", async () => {
    const { client } = createFakeClient({
      sourceItems: [],
      runInsertError: {
        message:
          'duplicate key value violates unique constraint "synthesis_runs_one_active_writer"',
        code: "23505",
      },
    });

    await expect(
      prepareRun({
        workspaceId: ids.workspace,
        triggerType: "manual",
        sourceItemIds: [],
        client,
      }),
    ).rejects.toBeInstanceOf(WorkspaceRunAlreadyActiveError);
  });

  it("rethrows a 23505 from a different constraint (e.g. duplicate idempotency key) unchanged", async () => {
    const { client } = createFakeClient({
      sourceItems: [],
      runInsertError: {
        message:
          'duplicate key value violates unique constraint "synthesis_runs_workspace_id_idempotency_key_key"',
        code: "23505",
      },
    });

    await expect(
      prepareRun({
        workspaceId: ids.workspace,
        triggerType: "manual",
        sourceItemIds: [],
        client,
      }),
    ).rejects.not.toBeInstanceOf(WorkspaceRunAlreadyActiveError);
  });
});

describe("markRunLaunched", () => {
  it("sets status=running and started_at on the run row", async () => {
    const { client, calls } = createFakeClient();

    await markRunLaunched(ids.run, fakeReceipt(), client);

    expect(calls.updates).toHaveLength(1);
    const update = calls.updates[0];
    expect(update.table).toBe("synthesis_runs");
    expect(update.id).toBe(ids.run);
    expect(update.payload.status).toBe("running");
    expect(typeof update.payload.started_at).toBe("string");
    expect(() => new Date(update.payload.started_at as string)).not.toThrow();
  });
});
