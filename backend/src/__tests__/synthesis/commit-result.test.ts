import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitSynthesisResult } from "../../synthesis/commit-result";
import type { ValidatedSynthesisResult } from "../../synthesis/types";
import { canonicalDocumentsHash } from "../../synthesis/context-version-files";

const ids = {
  workspace: "33333333-3333-4333-8333-333333333333",
  baseVersion: "44444444-4444-4444-8444-444444444444",
  run: "55555555-5555-4555-8555-555555555555",
  newVersion: "66666666-6666-4666-8666-666666666666",
};

interface FakeClientOptions {
  liveCurrentContextVersionId?: string;
  baseDocuments?: Record<string, { content: string; sha256: string }>;
  baseVersionNumber?: number;
  lastSequenceNumber?: number | null;
}

/**
 * Minimal fake standing in for the chainable Supabase query builder shape
 * used by commit-result.ts:
 * `.from().select().eq().single()`, `.from().update().eq()`,
 * `.from().insert().select().single()`,
 * `.from().select().eq().order().limit().maybeSingle()`.
 * Records every insert/update call so tests can assert on payloads sent.
 */
function createFakeClient(options: FakeClientOptions = {}) {
  const calls: {
    contextVersionInserts: Record<string, unknown>[];
    workspaceUpdates: Record<string, unknown>[];
    eventInserts: Record<string, unknown>[];
    runUpdates: Record<string, unknown>[];
  } = {
    contextVersionInserts: [],
    workspaceUpdates: [],
    eventInserts: [],
    runUpdates: [],
  };

  const baseDocuments = options.baseDocuments ?? {
    "company/index.md": {
      content: "base content",
      sha256: "a".repeat(64),
    },
  };
  const baseVersionNumber = options.baseVersionNumber ?? 3;
  const liveCurrentContextVersionId =
    options.liveCurrentContextVersionId ?? ids.baseVersion;

  function from(table: string) {
    if (table === "synthesis_runs") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: {
                id: ids.run,
                workspace_id: ids.workspace,
                base_context_version_id: ids.baseVersion,
              },
              error: null,
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (_column: string, _id: string) => {
            calls.runUpdates.push(payload);
            return { data: null, error: null };
          },
        }),
      };
    }

    if (table === "workspaces") {
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { current_context_version_id: liveCurrentContextVersionId },
              error: null,
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => ({
          eq: async (_column: string, _id: string) => {
            calls.workspaceUpdates.push(payload);
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
                id: ids.baseVersion,
                workspace_id: ids.workspace,
                version_number: baseVersionNumber,
                previous_version_id: null,
                documents_json: baseDocuments,
                content_hash: canonicalDocumentsHash(baseDocuments),
                creation_reason: "seed",
                synthesis_run_id: null,
                restored_from_version_id: null,
                summary: "base",
                created_at: new Date().toISOString(),
              },
              error: null,
            }),
          }),
        }),
        insert: (payload: Record<string, unknown>) => {
          calls.contextVersionInserts.push(payload);
          return {
            select: () => ({
              single: async () => ({
                data: { ...payload, id: ids.newVersion },
                error: null,
              }),
            }),
          };
        },
      };
    }

    if (table === "workspace_events") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: async () => ({
                  data:
                    options.lastSequenceNumber === undefined
                      ? null
                      : options.lastSequenceNumber === null
                        ? null
                        : { sequence_number: options.lastSequenceNumber },
                  error: null,
                }),
              }),
            }),
          }),
        }),
        insert: async (payload: Record<string, unknown>) => {
          calls.eventInserts.push(payload);
          return { data: null, error: null };
        },
      };
    }

    throw new Error(`Unexpected table in fake client: ${table}`);
  }

  const client = { from } as unknown as SupabaseClient;
  return { client, calls };
}

function baseValidated(
  overrides: Partial<ValidatedSynthesisResult["payload"]> = {},
): ValidatedSynthesisResult {
  return {
    runId: ids.run,
    bundleHash: "bundle-hash",
    payload: {
      outcome: "changed",
      summary: "Updated company doc.",
      documents: { "company/index.md": "new content" },
      ...overrides,
    },
  };
}

describe("commitSynthesisResult", () => {
  it("marks the run stale and writes nothing when the base version is no longer current", async () => {
    const { client, calls } = createFakeClient({
      liveCurrentContextVersionId: "99999999-9999-4999-8999-999999999999",
    });

    await commitSynthesisResult(baseValidated(), client);

    expect(calls.contextVersionInserts).toHaveLength(0);
    expect(calls.workspaceUpdates).toHaveLength(0);
    expect(calls.eventInserts).toHaveLength(0);
    expect(calls.runUpdates).toHaveLength(1);
    const update = calls.runUpdates[0];
    expect(update.status).toBe("stale");
    expect(update.outcome).toBe("stale");
    expect(typeof update.result_summary).toBe("string");
    expect(update.completed_at).toBeDefined();
  });

  it("commits a new version, advances the pointer, and records an event on 'changed'", async () => {
    const { client, calls } = createFakeClient({ baseVersionNumber: 3 });

    await commitSynthesisResult(baseValidated(), client);

    expect(calls.contextVersionInserts).toHaveLength(1);
    const versionInsert = calls.contextVersionInserts[0];
    expect(versionInsert.workspace_id).toBe(ids.workspace);
    expect(versionInsert.version_number).toBe(4);
    expect(versionInsert.previous_version_id).toBe(ids.baseVersion);
    expect(versionInsert.creation_reason).toBe("synthesis");
    expect(versionInsert.synthesis_run_id).toBe(ids.run);
    const newDocs = versionInsert.documents_json as Record<
      string,
      { content: string; sha256: string }
    >;
    expect(newDocs["company/index.md"].content).toBe("new content");

    expect(calls.workspaceUpdates).toHaveLength(1);
    expect(calls.workspaceUpdates[0].current_context_version_id).toBe(ids.newVersion);

    expect(calls.eventInserts).toHaveLength(1);
    expect(calls.eventInserts[0].event_type).toBe("context_updated");
    expect(calls.eventInserts[0].context_version_id).toBe(ids.newVersion);
    expect(calls.eventInserts[0].synthesis_run_id).toBe(ids.run);

    expect(calls.runUpdates).toHaveLength(1);
    const runUpdate = calls.runUpdates[0];
    expect(runUpdate.status).toBe("succeeded");
    expect(runUpdate.outcome).toBe("changed");
    expect(runUpdate.result_hash).toBe(versionInsert.content_hash);
  });

  it("writes no new version and leaves the pointer untouched on 'no_change'", async () => {
    const { client, calls } = createFakeClient();

    await commitSynthesisResult(
      baseValidated({ outcome: "no_change", documents: {} }),
      client,
    );

    expect(calls.contextVersionInserts).toHaveLength(0);
    expect(calls.workspaceUpdates).toHaveLength(0);

    expect(calls.eventInserts).toHaveLength(1);
    expect(calls.eventInserts[0].event_type).toBe("no_change");
    expect(calls.eventInserts[0].context_version_id).toBeNull();

    expect(calls.runUpdates).toHaveLength(1);
    const runUpdate = calls.runUpdates[0];
    expect(runUpdate.status).toBe("succeeded");
    expect(runUpdate.outcome).toBe("no_change");
    expect(runUpdate.result_hash).toBeUndefined();
  });
});
