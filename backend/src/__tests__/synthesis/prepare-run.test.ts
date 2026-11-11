import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  markRunLaunched,
  prepareRun,
  WorkspaceRunAlreadyActiveError,
} from "../../synthesis/prepare-run";
import { MEMORY_INDEX_PATH, resolveMemoryPeriod } from "../../synthesis/memory-period";
import type { SandboxRunReceipt } from "../../sandbox";

// Matches whatever "today" the suite actually runs on, so the default fake
// existing version already has this run's memory documents provisioned --
// ensureMemoryProvisioned is a no-op for every test below except the ones
// that deliberately start from an empty context (currentContextVersionId:
// null), which exercise real provisioning.
function defaultProvisionedMemoryDocuments(): Record<string, { content: string; sha256: string }> {
  const now = new Date();
  const stub = { content: "x", sha256: "a".repeat(64) };
  const documents: Record<string, { content: string; sha256: string }> = {
    [MEMORY_INDEX_PATH]: stub,
  };
  for (const period of ["today", "this-week", "this-month"] as const) {
    documents[resolveMemoryPeriod(period, "UTC", now).path] = stub;
  }
  return documents;
}

const ids = {
  workspace: "33333333-3333-4333-8333-333333333333",
  version: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  scheduledTask: "77777777-7777-4777-8777-777777777777",
  sourceA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sourceB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  seededVersion: "66666666-6666-4666-8666-666666666666",
};

interface FakeClientOptions {
  currentContextVersionId?: string | null;
  existingDocuments?: Record<string, { content: string; sha256: string }>;
  existingVersionNumber?: number;
  sourceItems?: Array<{
    id: string;
    workspace_id: string;
    lifecycle_status: "active" | "superseded" | "deleted";
    external_version: string;
    content_hash: string | null;
  }>;
  runInsertError?: { message: string; code: string };
  membershipInsertError?: Error;
  contextVersionInsertError?: { message: string; code: string };
  // Newest run already in the workspace, as the attempt computation sees it.
  latestRun?: { id: string; status: string; attempt: number };
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
    contextVersionInserts: Record<string, unknown>[];
    errorInserts: Record<string, unknown>[];
    updates: Array<{ table: string; payload: Record<string, unknown>; id: string }>;
  } = { order: [], runInserts: [], membershipInserts: [], contextVersionInserts: [], errorInserts: [], updates: [] };

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
              data: { current_context_version_id: currentContextVersionId, timezone: "UTC" },
              error: null,
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (_column: string, id: string) => {
            calls.updates.push({ table: "workspaces", payload, id });
            return { data: null, error: null };
          },
        }),
      };
    }

    if (table === "workspace_context_versions") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                documents_json: options.existingDocuments ?? defaultProvisionedMemoryDocuments(),
                version_number: options.existingVersionNumber ?? 3,
              },
              error: null,
            }),
          }),
        }),
      };
    }

    if (table === "errors") {
      return {
        insert: async (payload: Record<string, unknown>) => {
          calls.errorInserts.push(payload);
          return { error: null };
        },
      };
    }

    if (table === "source_items") {
      return {
        select: () => {
          let filtered = sourceItems;
          const query = {
            eq: (column: string, value: string) => {
              filtered = filtered.filter(
                (item) => item[column as keyof typeof item] === value,
              );
              return query;
            },
            then: (
              resolve: (value: { data: typeof sourceItems; error: null }) => void,
            ) => resolve({ data: filtered, error: null }),
          };
          return query;
        },
      };
    }

    if (table === "agent_runs") {
      return {
        select: () => {
          const query: Record<string, unknown> = {
            eq: () => query,
            in: () => {
              calls.order.push("sweep-select");
              return query;
            },
            lt: () => emptySweepSelectResult(),
            order: () => query,
            limit: async () => ({ data: options.latestRun ? [options.latestRun] : [], error: null }),
          };
          return query;
        },
        insert: async (payload: Record<string, unknown>) => {
          calls.order.push("run-insert");
          calls.runInserts.push(payload);
          return { data: null, error: options.runInsertError ?? null };
        },
        update: (payload: Record<string, unknown>) => ({
          eq: async (_column: string, id: string) => {
            calls.updates.push({ table: "agent_runs", payload, id });
            return { data: null, error: null };
          },
        }),
      };
    }

    if (table === "agent_run_source_items") {
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

  // The context commit RPC: records the version a writer would create, in the shape the old direct insert had.
  async function rpc(name: string, args: Record<string, unknown>) {
    if (name !== "commit_context_write") throw new Error(`Unexpected rpc ${name}`);
    calls.order.push(args.p_creation_reason === "memory_provision" ? "memory-provision-insert" : "seed-context-version-insert");
    calls.contextVersionInserts.push({
      workspace_id: args.p_workspace_id,
      expected_version_id: args.p_expected_version_id,
      creation_reason: args.p_creation_reason,
      content_hash: args.p_content_hash,
      documents_json: args.p_documents_json,
    });
    if (options.contextVersionInsertError && args.p_creation_reason === "memory_provision") {
      return { data: null, error: options.contextVersionInsertError };
    }
    return { data: { status: "committed", new_version_id: ids.seededVersion, version_number: 1 }, error: null };
  }

  const client = { from, rpc } as unknown as SupabaseClient;
  return { client, calls };
}

function fakeReceipt(): SandboxRunReceipt {
  return {
    machineId: "machine-1",
    state: "started",
    runId: ids.run,
    bundleHash: "hash-1",
    callbackExpiresAt: Date.now() + 60_000,
  };
}

describe("prepareRun", () => {
  it("uses {scheduled_task_id}:{occurrence_at} for scheduled runs", async () => {
    const { client, calls } = createFakeClient({ sourceItems: [] });
    const occurrenceAt = "2026-08-05T08:00:00.000Z";

    await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "schedule",
      sourceItemIds: [],
      scheduledTaskId: ids.scheduledTask,
      occurrenceAt,
      client,
    });

    expect(calls.runInserts).toHaveLength(1);
    const insert = calls.runInserts[0];
    expect(insert.scheduled_task_id).toBe(ids.scheduledTask);
    expect(insert.idempotency_key).toBe(`${ids.scheduledTask}:${occurrenceAt}`);
  });

  it("throws if scheduledTaskId is given without occurrenceAt", async () => {
    const { client } = createFakeClient({ sourceItems: [] });

    await expect(
      prepareRun({
        workspaceId: ids.workspace,
        triggerType: "schedule",
        sourceItemIds: [],
        scheduledTaskId: ids.scheduledTask,
        client,
      }),
    ).rejects.toThrow(/occurrenceAt/);
  });

  it("re-dispatching the same occurrence produces the same idempotency key", async () => {
    const { client, calls } = createFakeClient({ sourceItems: [] });
    const occurrenceAt = "2026-08-05T13:00:00.000Z";

    await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "schedule",
      sourceItemIds: [],
      scheduledTaskId: ids.scheduledTask,
      occurrenceAt,
      client,
    });
    await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "schedule",
      sourceItemIds: [],
      scheduledTaskId: ids.scheduledTask,
      occurrenceAt,
      client,
    }).catch(() => undefined); // fake client doesn't enforce the unique constraint; real DB would reject the second insert

    expect(calls.runInserts[0].idempotency_key).toBe(calls.runInserts[1].idempotency_key);
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

  it("auto-seeds an empty context version when the workspace has none yet", async () => {
    const { client, calls } = createFakeClient({ currentContextVersionId: null, sourceItems: [] });

    const runId = await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [],
      client,
    });

    expect(runId).toBe((calls.runInserts[0] as { id: string }).id);
    // A single insert seeds the version with memory's stubs already folded
    // in -- no separate memory-provision insert right on top of it (memory
    // is auto-provisioned unconditionally -- see prepare-run.ts).
    expect(calls.contextVersionInserts).toHaveLength(1);
    const seeded = calls.contextVersionInserts[0];
    expect(seeded.workspace_id).toBe(ids.workspace);
    expect(seeded.expected_version_id).toBeNull();
    expect(seeded.creation_reason).toBe("seed");
    expect(typeof seeded.content_hash).toBe("string");
    expect(seeded.content_hash).toMatch(/^[0-9a-f]{64}$/);
    const seededPaths = Object.keys(seeded.documents_json as Record<string, unknown>);
    expect(seededPaths).toContain(MEMORY_INDEX_PATH);
    expect(seededPaths.some((p) => p.startsWith("memory/days/"))).toBe(true);

    const runInsert = calls.runInserts[0];
    expect(runInsert.base_context_version_id).toBe(ids.seededVersion);
    expect(calls.order[0]).toBe("sweep-select");
    expect(calls.order).toContain("seed-context-version-insert");
    expect(calls.order.indexOf("seed-context-version-insert")).toBeLessThan(calls.order.indexOf("run-insert"));
  });

  it("records a memory_provision_failed error and rethrows when provisioning fails", async () => {
    const { client, calls } = createFakeClient({
      // Empty, so ensureMemoryProvisioned finds everything missing and
      // actually attempts an insert instead of no-op'ing.
      existingDocuments: {},
      sourceItems: [],
      contextVersionInsertError: { message: "insert failed", code: "23505" },
    });

    await expect(
      prepareRun({
        workspaceId: ids.workspace,
        triggerType: "manual",
        sourceItemIds: [],
        client,
      }),
    ).rejects.toMatchObject({ message: "insert failed", code: "23505" });

    expect(calls.errorInserts).toHaveLength(1);
    const errorInsert = calls.errorInserts[0];
    expect(errorInsert.workspace_id).toBe(ids.workspace);
    expect(errorInsert.operation).toBe("queue");
    expect(errorInsert.message).toBe("Memory provisioning failed during prepareRun");
    expect((errorInsert.detail_json as Record<string, unknown>).code).toBe("memory_provision_failed");
    expect(calls.runInserts).toHaveLength(0);
  });

  it("assigns position 0..n-1 to source items in the given order and pulls version/hash from source_items", async () => {
    const { client, calls } = createFakeClient({
      sourceItems: [
        {
          id: ids.sourceA,
          workspace_id: ids.workspace,
          lifecycle_status: "active",
          external_version: "3",
          content_hash: "hash-a",
        },
        {
          id: ids.sourceB,
          workspace_id: ids.workspace,
          lifecycle_status: "active",
          external_version: "7",
          content_hash: "hash-b",
        },
      ],
    });

    const runId = await prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [ids.sourceB, ids.sourceA],
      client,
    });

    expect(runId).toBe((calls.runInserts[0] as { id: string }).id);
    expect(calls.membershipInserts).toHaveLength(2);
    expect(calls.membershipInserts[0]).toMatchObject({
      workspace_id: ids.workspace,
      agent_run_id: expect.any(String),
      source_item_id: ids.sourceB,
      position: 0,
      source_item_version: "7",
      content_hash: "hash-b",
    });
    expect(calls.membershipInserts[1]).toMatchObject({
      workspace_id: ids.workspace,
      agent_run_id: expect.any(String),
      source_item_id: ids.sourceA,
      position: 1,
      source_item_version: "3",
      content_hash: "hash-a",
    });
  });

  it("rejects superseded source items before creating a run", async () => {
    const { client, calls } = createFakeClient({
      sourceItems: [{
        id: ids.sourceA,
        workspace_id: ids.workspace,
        lifecycle_status: "superseded",
        external_version: "3",
        content_hash: "hash-a",
      }],
    });

    await expect(prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [ids.sourceA],
      client,
    })).rejects.toThrow(/ineligible.*source items/i);
    expect(calls.runInserts).toHaveLength(0);
    expect(calls.membershipInserts).toHaveLength(0);
  });

  it("rejects source items from another workspace before creating a run", async () => {
    const { client, calls } = createFakeClient({
      sourceItems: [{
        id: ids.sourceA,
        workspace_id: "99999999-9999-4999-8999-999999999999",
        lifecycle_status: "active",
        external_version: "3",
        content_hash: "hash-a",
      }],
    });

    await expect(prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [ids.sourceA],
      client,
    })).rejects.toThrow(ids.sourceA);
    expect(calls.runInserts).toHaveLength(0);
    expect(calls.membershipInserts).toHaveLength(0);
  });

  it("rejects deleted source items before creating a run", async () => {
    const { client, calls } = createFakeClient({
      sourceItems: [{
        id: ids.sourceA,
        workspace_id: ids.workspace,
        lifecycle_status: "deleted",
        external_version: "3",
        content_hash: "hash-a",
      }],
    });

    await expect(prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [ids.sourceA],
      client,
    })).rejects.toThrow(ids.sourceA);
    expect(calls.runInserts).toHaveLength(0);
  });

  it("rejects duplicate requested source IDs before creating a run", async () => {
    const { client, calls } = createFakeClient({
      sourceItems: [{
        id: ids.sourceA,
        workspace_id: ids.workspace,
        lifecycle_status: "active",
        external_version: "3",
        content_hash: "hash-a",
      }],
    });

    await expect(prepareRun({
      workspaceId: ids.workspace,
      triggerType: "manual",
      sourceItemIds: [ids.sourceA, ids.sourceA],
      client,
    })).rejects.toThrow(/duplicate/i);
    expect(calls.runInserts).toHaveLength(0);
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
          'duplicate key value violates unique constraint "agent_runs_one_active_synthesis"',
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
          'duplicate key value violates unique constraint "agent_runs_workspace_id_idempotency_key_key"',
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

describe("prepareRun attempt tracking", () => {
  const base = { workspaceId: ids.workspace, triggerType: "manual" as const, sourceItemIds: [] };

  it("continues the streak when the latest run failed", async () => {
    const { client, calls } = createFakeClient({ latestRun: { id: "r", status: "failed", attempt: 2 } });

    await prepareRun({ ...base, client });

    expect(calls.runInserts[0].attempt).toBe(3);
  });

  it("resets to 1 when the latest run succeeded", async () => {
    const { client, calls } = createFakeClient({ latestRun: { id: "r", status: "succeeded", attempt: 3 } });

    await prepareRun({ ...base, client });

    expect(calls.runInserts[0].attempt).toBe(1);
  });

  it("links a retry to its failed run with a one-per-failure idempotency key", async () => {
    const { client, calls } = createFakeClient({ latestRun: { id: "12121212-1212-4212-8212-121212121212", status: "failed", attempt: 1 } });

    await prepareRun({
      ...base,
      triggerType: "retry",
      retryOfRunId: "12121212-1212-4212-8212-121212121212",
      scheduledTaskId: ids.scheduledTask,
      client,
    });

    expect(calls.runInserts[0]).toMatchObject({
      attempt: 2,
      retry_of_run_id: "12121212-1212-4212-8212-121212121212",
      idempotency_key: "retry:12121212-1212-4212-8212-121212121212",
      trigger: { type: "retry", retryOf: "12121212-1212-4212-8212-121212121212" },
    });
  });
});

describe("markRunLaunched", () => {
  it("sets status=running and started_at on the run row", async () => {
    const { client, calls } = createFakeClient();

    await markRunLaunched(ids.run, fakeReceipt(), client);

    expect(calls.updates).toHaveLength(1);
    const update = calls.updates[0];
    expect(update.table).toBe("agent_runs");
    expect(update.id).toBe(ids.run);
    expect(update.payload.status).toBe("running");
    expect(update.payload.sandbox_machine_id).toBe("machine-1");
    expect(typeof update.payload.started_at).toBe("string");
    expect(() => new Date(update.payload.started_at as string)).not.toThrow();
  });
});
