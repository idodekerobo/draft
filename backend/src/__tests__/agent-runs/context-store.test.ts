import { describe, expect, it } from "bun:test";
import { sha256 } from "../../synthesis/context-version-files";
import { writeContext } from "../../agent-runs/context-store";
import { createFakeContextDb } from "./fake-context-db";

const WS = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

function setup(files: Record<string, string>) {
  const db = createFakeContextDb(files);
  const baseVersionId = db.pointer()!;
  const write = (changes: Parameters<typeof writeContext>[1]["changes"]) =>
    writeContext(db.client, { workspaceId: WS, agentRunId: RUN, baseVersionId, changes, summary: "test write" });
  return { db, write, baseVersionId };
}

describe("writeContext", () => {
  it("writes a changed document and keeps the others", async () => {
    const { db, write } = setup({ "a.md": "A", "b.md": "B" });
    const result = await write([{ path: "a.md", content: "A2" }]);
    expect(result).toMatchObject({ status: "committed", written: ["a.md"], conflicts: [] });
    expect(db.current()["a.md"].content).toBe("A2");
    expect(db.current()["b.md"].content).toBe("B");
    expect(db.rpcCalls[0]).toMatchObject({ p_creation_reason: "agent_write", p_agent_run_id: RUN });
  });

  it("writes the documents that do not conflict and returns the ones that do, in one version", async () => {
    const { db, write } = setup({ "a.md": "A", "b.md": "B", "c.md": "C" });
    db.writeBehindTheScenes({ "b.md": "B by someone else" });
    const versionsBefore = db.versionCount();
    const result = await write([
      { path: "a.md", content: "A2" },
      { path: "b.md", content: "B2" },
      { path: "new.md", content: "new", baseSha: null },
    ]);
    if (result.status !== "committed") throw new Error("expected committed");
    expect(result.written).toEqual(["a.md", "new.md"]);
    expect(result.conflicts.map((conflict) => conflict.path)).toEqual(["b.md"]);
    expect(result.conflicts[0]!.currentContent).toBe("B by someone else");
    expect(db.versionCount()).toBe(versionsBefore + 1);
    expect(db.current()["a.md"].content).toBe("A2");
    expect(db.current()["new.md"].content).toBe("new");
    expect(db.current()["b.md"].content).toBe("B by someone else");
  });

  it("takes any number of documents, within the size caps", async () => {
    const { db, write } = setup({ "a.md": "A" });
    const changes = Array.from({ length: 60 }, (_, i) => ({ path: `many/${i}.md`, content: `doc ${i}`, baseSha: null }));
    const result = await write(changes);
    expect(result).toMatchObject({ status: "committed" });
    expect(Object.keys(db.current())).toHaveLength(61);
    const big = "x".repeat(199_000);
    await expect(write(Array.from({ length: 21 }, (_, i) => ({ path: `big/${i}.md`, content: big, baseSha: null })))).rejects.toThrow("at most");
    await expect(write([{ path: "huge.md", content: "x".repeat(200_001), baseSha: null }])).rejects.toThrow("too large");
  });

  it("uses the reason it is given for the version", async () => {
    const { db } = setup({ "a.md": "A" });
    await writeContext(db.client, { workspaceId: WS, agentRunId: RUN, baseVersionId: db.pointer()!, changes: [{ path: "a.md", content: "A2" }], summary: "s", reason: "synthesis" });
    expect(db.rpcCalls.at(-1)).toMatchObject({ p_creation_reason: "synthesis" });
  });

  it("defaults each change's base sha to the sha in the run's base version", async () => {
    const { db, write } = setup({ "a.md": "A" });
    db.writeBehindTheScenes({ "a.md": "changed by someone else" });
    const result = await write([{ path: "a.md", content: "mine" }]);
    expect(result).toMatchObject({ status: "conflict" });
    if (result.status !== "conflict") throw new Error("unreachable");
    expect(result.conflicts[0]).toEqual({
      path: "a.md",
      currentSha: sha256("changed by someone else"),
      currentContent: "changed by someone else",
      yourBaseSha: sha256("A"),
    });
    expect(db.current()["a.md"].content).toBe("changed by someone else");
  });

  it("lets a write to one document through when only another document changed", async () => {
    const { db, write } = setup({ "a.md": "A", "b.md": "B" });
    db.writeBehindTheScenes({ "b.md": "B changed" });
    const result = await write([{ path: "a.md", content: "A2" }]);
    expect(result.status).toBe("committed");
    expect(db.current()["a.md"].content).toBe("A2");
    expect(db.current()["b.md"].content).toBe("B changed");
  });

  it("accepts the current sha after a conflict, which is the rebase", async () => {
    const { db, write } = setup({ "a.md": "A" });
    db.writeBehindTheScenes({ "a.md": "theirs" });
    const first = await write([{ path: "a.md", content: "merged" }]);
    if (first.status !== "conflict") throw new Error("expected conflict");
    const second = await write([{ path: "a.md", content: "merged", baseSha: first.conflicts[0].currentSha }]);
    expect(second.status).toBe("committed");
    expect(db.current()["a.md"].content).toBe("merged");
  });

  it("retries on its own when another write lands between the check and the commit", async () => {
    const { db, write } = setup({ "a.md": "A", "b.md": "B" });
    db.hooks.beforeCommit = () => {
      db.writeBehindTheScenes({ "b.md": "B changed" });
    };
    const result = await write([{ path: "a.md", content: "A2" }]);
    expect(result.status).toBe("committed");
    expect(db.rpcCalls).toHaveLength(2);
    expect(db.current()["b.md"].content).toBe("B changed");
    expect(db.current()["a.md"].content).toBe("A2");
  });

  it("conflicts instead of overwriting when the retry finds the same document changed", async () => {
    const { db, write } = setup({ "a.md": "A" });
    db.hooks.beforeCommit = () => {
      db.writeBehindTheScenes({ "a.md": "A by someone else" });
    };
    const result = await write([{ path: "a.md", content: "A2" }]);
    expect(result.status).toBe("conflict");
    expect(db.current()["a.md"].content).toBe("A by someone else");
  });

  it("creates a new document, and conflicts if someone created it first", async () => {
    const { db, write } = setup({ "a.md": "A" });
    expect((await write([{ path: "new.md", content: "N" }])).status).toBe("committed");
    const { db: db2, write: write2 } = setup({ "a.md": "A" });
    db2.writeBehindTheScenes({ "new.md": "theirs" });
    expect((await write2([{ path: "new.md", content: "N" }])).status).toBe("conflict");
    expect(db.current()["new.md"].content).toBe("N");
  });

  it("treats baseSha null as 'this document must not exist'", async () => {
    const { write } = setup({ "a.md": "A" });
    expect((await write([{ path: "a.md", content: "A2", baseSha: null }])).status).toBe("conflict");
  });

  it("reports unchanged and creates no version when the content is the same", async () => {
    const { db, write } = setup({ "a.md": "A" });
    expect(await write([{ path: "a.md", content: "A" }])).toEqual({ status: "unchanged" });
    expect(db.versionCount()).toBe(1);
  });

  it("conflicts, and writes nothing, when every document conflicts", async () => {
    const { db, write } = setup({ "a.md": "A", "b.md": "B" });
    db.writeBehindTheScenes({ "a.md": "A changed", "b.md": "B changed" });
    const versionsBefore = db.versionCount();
    const result = await write([{ path: "a.md", content: "A2" }, { path: "b.md", content: "B2" }]);
    expect(result.status).toBe("conflict");
    expect(db.versionCount()).toBe(versionsBefore);
  });

  it("rejects unsafe paths, duplicate paths and oversized documents", async () => {
    const { write } = setup({ "a.md": "A" });
    await expect(write([{ path: "../x.md", content: "x" }])).rejects.toThrow("safe relative Markdown path");
    await expect(write([{ path: "a.txt", content: "x" }])).rejects.toThrow("safe relative Markdown path");
    await expect(write([{ path: "a.md", content: "x" }, { path: "a.md", content: "y" }])).rejects.toThrow("duplicate path");
    await expect(write([{ path: "a.md", content: "x".repeat(200_001) }])).rejects.toThrow("too large");
  });
});
