import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("step runs", "steps");

async function baseVersion(workspaceId: string): Promise<string> {
  const [row] = await db()<[{ id: string }]>`
    insert into workspace_context_versions (workspace_id, version_number, documents_json, content_hash, creation_reason, summary)
    values (${workspaceId}, 1, '{}'::jsonb, ${"b".repeat(64)}, 'seed', 'seed') returning id
  `;
  return row.id;
}

async function insertRun(workspaceId: string, versionId: string, fields: { kind: string; parentRunId?: string | null; stepKey?: string | null; idempotencyKey?: string; status?: string }): Promise<string> {
  const id = randomUUID();
  await db()`
    insert into agent_runs (id, workspace_id, kind, trigger, execution, toolset, computer, harness, idempotency_key, base_context_version_id, status, parent_run_id, step_key)
    values (${id}, ${workspaceId}, ${fields.kind}, '{"type":"system","reason":"manual"}'::jsonb,
      '{"target":{"type":"sandbox"},"adapterId":"claude-print"}'::jsonb,
      '{"nativeTools":[],"mcpServers":[],"skills":[],"instructions":[]}'::jsonb,
      '{"type":"sandbox","profileId":"default","workingDirectory":"/run","network":"restricted"}'::jsonb,
      'claude', ${fields.idempotencyKey ?? randomUUID()}, ${versionId}, ${fields.status ?? "running"}, ${fields.parentRunId ?? null}, ${fields.stepKey ?? null})
  `;
  return id;
}

describeWithDatabase("step runs", () => {
  test("a step run needs a parent, and no other run may have one", async () => {
    const { workspaceId } = await createWorkspace();
    const version = await baseVersion(workspaceId);
    const parent = await insertRun(workspaceId, version, { kind: "synthesis" });
    await insertRun(workspaceId, version, { kind: "step", parentRunId: parent, stepKey: "capture" });
    await expect(insertRun(workspaceId, version, { kind: "step" })).rejects.toThrow();
    await expect(insertRun(workspaceId, version, { kind: "synthesis", parentRunId: parent })).rejects.toThrow();
  });

  test("a step run cannot point at another workspace's run", async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();
    const parent = await insertRun(first.workspaceId, await baseVersion(first.workspaceId), { kind: "synthesis" });
    await expect(insertRun(second.workspaceId, await baseVersion(second.workspaceId), { kind: "step", parentRunId: parent, stepKey: "capture" })).rejects.toThrow();
  });

  test("a parent that has step runs cannot be deleted", async () => {
    const { workspaceId } = await createWorkspace();
    const version = await baseVersion(workspaceId);
    const parent = await insertRun(workspaceId, version, { kind: "synthesis" });
    await insertRun(workspaceId, version, { kind: "step", parentRunId: parent, stepKey: "capture" });
    await expect(db()`delete from agent_runs where id = ${parent}`).rejects.toThrow();
  });

  test("step runs are not held to one active synthesis run, but a second parent is", async () => {
    const { workspaceId } = await createWorkspace();
    const version = await baseVersion(workspaceId);
    const parent = await insertRun(workspaceId, version, { kind: "synthesis" });
    for (const stepKey of ["a", "b", "c"]) await insertRun(workspaceId, version, { kind: "step", parentRunId: parent, stepKey });
    await expect(insertRun(workspaceId, version, { kind: "synthesis" })).rejects.toThrow();
  });

  test("two callers that plan the same step insert each run once", async () => {
    const { workspaceId } = await createWorkspace();
    const version = await baseVersion(workspaceId);
    const parent = await insertRun(workspaceId, version, { kind: "synthesis" });
    const key = `${parent}:capture:batch-1:1`;
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => insertRun(workspaceId, version, { kind: "step", parentRunId: parent, stepKey: "capture", idempotencyKey: key, status: "queued" })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
  });

  test("a guarded update claims a queued run for one caller only", async () => {
    const { workspaceId } = await createWorkspace();
    const version = await baseVersion(workspaceId);
    const parent = await insertRun(workspaceId, version, { kind: "synthesis" });
    const run = await insertRun(workspaceId, version, { kind: "step", parentRunId: parent, stepKey: "capture", status: "queued" });
    const claims = await Promise.all([1, 2, 3, 4].map(() => db()<Array<{ id: string }>>`update agent_runs set status = 'preparing' where id = ${run} and status = 'queued' returning id`));
    expect(claims.filter((rows) => rows.length === 1)).toHaveLength(1);
  });
});
