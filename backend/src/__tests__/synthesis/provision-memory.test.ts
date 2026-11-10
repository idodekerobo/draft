import { describe, expect, it } from "bun:test";
import { computeMemoryAdditions, ensureMemoryProvisioned } from "../../synthesis/provision-memory";
import { MEMORY_INDEX_PATH } from "../../synthesis/memory-period";
import { createFakeContextDb, docs } from "../metaharness/context/fake-context-db";

const workspaceId = "11111111-1111-4111-8111-111111111111";

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

const ALL_PATHS = [
  "memory/days/2026-09-25.md",
  MEMORY_INDEX_PATH,
  "memory/months/2026-09.md",
  "memory/weeks/2026-09-21.md",
];

function provision(db: ReturnType<typeof createFakeContextDb>) {
  return ensureMemoryProvisioned({
    client: db.client,
    workspaceId,
    baseVersionId: db.pointer()!,
    documents: db.current(),
    timezone: "UTC",
    now: NOW,
  });
}

describe("ensureMemoryProvisioned", () => {
  it("provisions index + today/this-week/this-month when nothing exists yet", async () => {
    const db = createFakeContextDb({});
    const before = db.pointer();

    const result = await provision(db);

    expect(result.baseContextVersionId).toBe(db.pointer()!);
    expect(result.baseContextVersionId).not.toBe(before);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0]).toMatchObject({ p_creation_reason: "memory_provision", p_expected_version_id: before, p_agent_run_id: null });
    expect(Object.keys(db.current()).sort()).toEqual(ALL_PATHS);
  });

  it("is a no-op once the current period documents already exist", async () => {
    const db = createFakeContextDb(Object.fromEntries(ALL_PATHS.map((path) => [path, "x"])));
    const before = db.pointer();

    const result = await provision(db);

    expect(result.baseContextVersionId).toBe(before!);
    expect(db.rpcCalls).toHaveLength(0);
  });

  it("only adds the missing pieces and keeps existing documents untouched", async () => {
    const db = createFakeContextDb({ [MEMORY_INDEX_PATH]: "keep me", "memory/days/2026-09-25.md": "keep me too" });

    await provision(db);

    expect(Object.keys(db.current()).sort()).toEqual(ALL_PATHS);
    expect(db.current()[MEMORY_INDEX_PATH].content).toBe("keep me");
    expect(db.current()["memory/days/2026-09-25.md"].content).toBe("keep me too");
  });

  it("keeps a write that lands first instead of overwriting it", async () => {
    const db = createFakeContextDb({});
    db.hooks.beforeCommit = () => {
      db.writeBehindTheScenes({ "company/about.md": "written by a routine" });
    };

    const result = await provision(db);

    expect(db.rpcCalls).toHaveLength(2);
    expect(result.baseContextVersionId).toBe(db.pointer()!);
    expect(db.current()["company/about.md"].content).toBe("written by a routine");
    expect(Object.keys(db.current())).toEqual(expect.arrayContaining(ALL_PATHS));
  });
});

void docs;
