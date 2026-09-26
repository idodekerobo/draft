import { describe, expect, it } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeMemoryAdditions, ensureMemoryProvisioned } from "../../synthesis/provision-memory";
import { MEMORY_INDEX_PATH } from "../../synthesis/memory-period";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const baseVersionId = "22222222-2222-4222-8222-222222222222";
const newVersionId = "33333333-3333-4333-8333-333333333333";

// 2026-09-25 is a Thursday.
const NOW = new Date("2026-09-25T18:00:00.000Z");

describe("computeMemoryAdditions", () => {
  it("is pure -- no I/O, just computes the missing paths", () => {
    const additions = computeMemoryAdditions({}, "UTC", NOW);
    expect(Object.keys(additions).sort()).toEqual([
      "memory/days/2026-09-25.md",
      MEMORY_INDEX_PATH,
      "memory/months/2026-09.md",
      "memory/weeks/2026-09-21.md",
    ]);
  });

  it("returns an empty object once everything is already present", () => {
    const documents = computeMemoryAdditions({}, "UTC", NOW);
    expect(computeMemoryAdditions(documents, "UTC", NOW)).toEqual({});
  });
});

function createFakeClient() {
  const inserted: Record<string, unknown>[] = [];
  const pointerUpdates: { workspaceId: string; versionId: string }[] = [];
  const client = {
    from: (table: string) => {
      if (table === "workspace_context_versions") {
        return {
          insert: (payload: Record<string, unknown>) => {
            inserted.push(payload);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id: newVersionId }, error: null }),
              }),
            };
          },
        };
      }
      if (table === "workspaces") {
        return {
          update: (payload: { current_context_version_id: string }) => ({
            eq: (_col: string, id: string) => {
              pointerUpdates.push({ workspaceId: id, versionId: payload.current_context_version_id });
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  } as unknown as SupabaseClient;
  return { client, inserted, pointerUpdates };
}

describe("ensureMemoryProvisioned", () => {
  it("provisions index + today/this-week/this-month when nothing exists yet", async () => {
    const { client, inserted, pointerUpdates } = createFakeClient();

    const result = await ensureMemoryProvisioned({
      client,
      workspaceId,
      baseVersionId,
      documents: {},
      versionNumber: 1,
      timezone: "UTC",
      now: NOW,
    });

    expect(result.baseContextVersionId).toBe(newVersionId);
    expect(inserted).toHaveLength(1);
    const payload = inserted[0] as { documents_json: Record<string, unknown>; version_number: number; creation_reason: string };
    expect(payload.version_number).toBe(2);
    expect(payload.creation_reason).toBe("memory_provision");
    expect(Object.keys(payload.documents_json).sort()).toEqual([
      "memory/days/2026-09-25.md",
      MEMORY_INDEX_PATH,
      "memory/months/2026-09.md",
      "memory/weeks/2026-09-21.md",
    ]);
    expect(pointerUpdates).toEqual([{ workspaceId, versionId: newVersionId }]);
  });

  it("is a no-op once the current period documents already exist", async () => {
    const { client, inserted } = createFakeClient();
    const documents = {
      [MEMORY_INDEX_PATH]: { content: "x", sha256: "a".repeat(64) },
      "memory/days/2026-09-25.md": { content: "x", sha256: "a".repeat(64) },
      "memory/weeks/2026-09-21.md": { content: "x", sha256: "a".repeat(64) },
      "memory/months/2026-09.md": { content: "x", sha256: "a".repeat(64) },
    };

    const result = await ensureMemoryProvisioned({
      client,
      workspaceId,
      baseVersionId,
      documents,
      versionNumber: 5,
      timezone: "UTC",
      now: NOW,
    });

    expect(result.baseContextVersionId).toBe(baseVersionId);
    expect(inserted).toHaveLength(0);
  });

  it("only provisions the missing pieces when some periods already exist", async () => {
    const { client, inserted } = createFakeClient();
    const documents = {
      [MEMORY_INDEX_PATH]: { content: "x", sha256: "a".repeat(64) },
      "memory/days/2026-09-25.md": { content: "x", sha256: "a".repeat(64) },
    };

    await ensureMemoryProvisioned({
      client,
      workspaceId,
      baseVersionId,
      documents,
      versionNumber: 5,
      timezone: "UTC",
      now: NOW,
    });

    const payload = inserted[0] as { documents_json: Record<string, unknown> };
    expect(Object.keys(payload.documents_json).sort()).toEqual([
      "memory/days/2026-09-25.md",
      MEMORY_INDEX_PATH,
      "memory/months/2026-09.md",
      "memory/weeks/2026-09-21.md",
    ]);
  });
});
