import { describe, expect, test } from "bun:test";
import { setupDbIntegrationTest } from "./support";

const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("context history", "history");

type Docs = Record<string, string | null>;

/** Adds a version holding these documents. A document's sha is its text, so a change in text is a change in sha. */
async function addVersion(workspaceId: string, versionNumber: number, docs: Docs, reason = "agent_write"): Promise<string> {
  const documents = Object.fromEntries(Object.entries(docs).filter(([, text]) => text !== null).map(([path, text]) => [path, { content: text, sha256: String(text).padEnd(64, "0").slice(0, 64) }]));
  const [row] = await db()<[{ id: string }]>`
    insert into workspace_context_versions (workspace_id, version_number, documents_json, content_hash, creation_reason, summary)
    values (${workspaceId}, ${versionNumber}, ${JSON.stringify(documents)}::jsonb, ${"c".repeat(64)}, ${reason}, ${`version ${versionNumber}`})
    returning id
  `;
  return row.id;
}

const history = async (workspaceId: string, path: string, limit = 10, scan = 300): Promise<number[]> => {
  const rows = await db()<Array<{ version_number: string }>>`select version_number from context_document_history(${workspaceId}, ${path}, ${limit}, ${scan})`;
  return rows.map((row) => Number(row.version_number));
};

const lastChanged = async (workspaceId: string, scan = 300): Promise<Record<string, number>> => {
  const rows = await db()<Array<{ path: string; version_number: string }>>`select path, version_number from context_documents_last_changed(${workspaceId}, ${scan})`;
  return Object.fromEntries(rows.map((row) => [row.path, Number(row.version_number)]));
};

describeWithDatabase("context document history", () => {
  test("lists only the versions that changed the document, newest first, including its creation", async () => {
    const { workspaceId } = await createWorkspace();
    await addVersion(workspaceId, 1, { "a.md": "one" });
    await addVersion(workspaceId, 2, { "a.md": "one", "b.md": "bee" });
    await addVersion(workspaceId, 3, { "a.md": "two", "b.md": "bee" });
    await addVersion(workspaceId, 4, { "a.md": "two", "b.md": "bee2" });
    expect(await history(workspaceId, "a.md")).toEqual([3, 1]);
    expect(await history(workspaceId, "b.md")).toEqual([4, 2]);
  });

  test("counts a deletion and a later return as changes", async () => {
    const { workspaceId } = await createWorkspace();
    await addVersion(workspaceId, 1, { "a.md": "one" });
    await addVersion(workspaceId, 2, { "a.md": null });
    await addVersion(workspaceId, 3, { "a.md": "one" });
    expect(await history(workspaceId, "a.md")).toEqual([3, 2, 1]);
  });

  test("gives nothing for a path that never existed, and respects the limit", async () => {
    const { workspaceId } = await createWorkspace();
    for (let n = 1; n <= 5; n += 1) await addVersion(workspaceId, n, { "a.md": `text ${n}` });
    expect(await history(workspaceId, "never.md")).toEqual([]);
    expect(await history(workspaceId, "a.md", 2)).toEqual([5, 4]);
  });

  test("reads only the newest versions it is told to, and does not call the window's oldest version a change", async () => {
    const { workspaceId } = await createWorkspace();
    for (let n = 1; n <= 6; n += 1) await addVersion(workspaceId, n, { "a.md": n <= 3 ? "old" : "new" });
    // Scan 3 reads versions 6, 5, 4 and 3. Version 4 is the change from "old" to "new" and is compared with 3.
    expect(await history(workspaceId, "a.md", 10, 3)).toEqual([4]);
    // Scan 2 reads versions 6, 5 and 4. Version 4 is the oldest of the window, so it has nothing to compare with.
    expect(await history(workspaceId, "a.md", 10, 2)).toEqual([]);
  });

  test("one workspace's history never shows another's", async () => {
    const { workspaceId: first } = await createWorkspace();
    const { workspaceId: second } = await createWorkspace();
    await addVersion(first, 1, { "a.md": "one" });
    await addVersion(second, 1, { "a.md": "other" });
    await addVersion(second, 2, { "a.md": "other2" });
    expect(await history(first, "a.md")).toEqual([1]);
    expect(await history(second, "a.md")).toEqual([2, 1]);
  });

  test("gives the last change of each document that is in the latest version", async () => {
    const { workspaceId } = await createWorkspace();
    await addVersion(workspaceId, 1, { "a.md": "one", "gone.md": "x" });
    await addVersion(workspaceId, 2, { "a.md": "one", "b.md": "bee" });
    await addVersion(workspaceId, 3, { "a.md": "two", "b.md": "bee" });
    expect(await lastChanged(workspaceId)).toEqual({ "a.md": 3, "b.md": 2 });
  });

  test("leaves out a document that did not change inside the window", async () => {
    const { workspaceId } = await createWorkspace();
    await addVersion(workspaceId, 1, { "a.md": "one", "b.md": "bee" });
    for (let n = 2; n <= 5; n += 1) await addVersion(workspaceId, n, { "a.md": "one", "b.md": `bee ${n}` });
    expect(await lastChanged(workspaceId, 2)).toEqual({ "b.md": 5 });
  });
});
