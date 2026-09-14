import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { setupDbIntegrationTest } from "./support";

const { describeWithDatabase, db, createWorkspace } = setupDbIntegrationTest("synthesis consumption", "consumption");

async function createConnection(workspaceId: string): Promise<string> {
  const [connection] = await db()<[{ id: string }]>`
    insert into source_connections (workspace_id, provider, connection_key, status)
    values (${workspaceId}, 'slack', ${randomUUID()}, 'active')
    returning id
  `;
  return connection.id;
}

interface SourceItemOptions {
  externalVersion?: string;
  contentHash?: string;
  lifecycleStatus?: string;
}

async function insertSourceItem(
  workspaceId: string,
  connectionId: string,
  options: SourceItemOptions = {},
): Promise<string> {
  const {
    externalVersion = "v1",
    contentHash = "a".repeat(64),
    lifecycleStatus = "active",
  } = options;
  const [row] = await db()<[{ id: string }]>`
    insert into source_items (
      workspace_id, source_connection_id, item_type, external_id, external_version,
      lifecycle_status, occurred_at, content_markdown, content_hash
    ) values (
      ${workspaceId}, ${connectionId}, 'message', ${randomUUID()}, ${externalVersion},
      ${lifecycleStatus}, now(), 'content', ${contentHash}
    )
    returning id
  `;
  return row.id;
}

async function createBaseContextVersion(workspaceId: string): Promise<string> {
  const [row] = await db()<[{ id: string }]>`
    insert into workspace_context_versions (
      workspace_id, version_number, documents_json, content_hash, creation_reason, summary
    ) values (
      ${workspaceId}, 1, '{}'::jsonb, ${"b".repeat(64)}, 'seed', 'seed version'
    )
    returning id
  `;
  return row.id;
}

interface SynthesisRunOptions {
  status?: string;
  outcome?: string | null;
}

async function createSynthesisRun(
  workspaceId: string,
  baseContextVersionId: string,
  options: SynthesisRunOptions = {},
): Promise<string> {
  const { status = "succeeded", outcome = "changed" } = options;
  const [row] = await db()<[{ id: string }]>`
    insert into synthesis_runs (
      workspace_id, idempotency_key, trigger_type, base_context_version_id,
      prompt_version, status, outcome
    ) values (
      ${workspaceId}, ${randomUUID()}, 'manual', ${baseContextVersionId},
      'v1', ${status}, ${outcome}
    )
    returning id
  `;
  return row.id;
}

async function addRunMembership(
  workspaceId: string,
  runId: string,
  sourceItemId: string,
  sourceItemVersion: string,
  contentHash: string,
  position = 0,
): Promise<void> {
  await db()`
    insert into synthesis_run_source_items (
      workspace_id, synthesis_run_id, source_item_id, position, source_item_version, content_hash
    ) values (
      ${workspaceId}, ${runId}, ${sourceItemId}, ${position}, ${sourceItemVersion}, ${contentHash}
    )
  `;
}

async function getPending(workspaceId: string, reprocess = false): Promise<string[]> {
  const rows = await db()<Array<{ source_item_id: string }>>`
    select * from get_pending_synthesis_source_item_ids(${workspaceId}, ${reprocess})
  `;
  return rows.map((r) => r.source_item_id);
}

describeWithDatabase("synthesis consumption migration", () => {
  test("a never-synthesized active source is pending", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const itemId = await insertSourceItem(workspaceId, connectionId);

    expect(await getPending(workspaceId)).toEqual([itemId]);
  });

  test("excludes a source whose exact version/hash was included in a succeeded 'changed' run", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);
    const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: "v1", contentHash: "c".repeat(64) });

    const run = await createSynthesisRun(workspaceId, baseVersion, { status: "succeeded", outcome: "changed" });
    await addRunMembership(workspaceId, run, itemId, "v1", "c".repeat(64));

    expect(await getPending(workspaceId)).toEqual([]);
  });

  test("excludes a source whose exact version/hash was included in a succeeded 'no_change' run", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);
    const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: "v1", contentHash: "c".repeat(64) });

    const run = await createSynthesisRun(workspaceId, baseVersion, { status: "succeeded", outcome: "no_change" });
    await addRunMembership(workspaceId, run, itemId, "v1", "c".repeat(64));

    expect(await getPending(workspaceId)).toEqual([]);
  });

  test("does not exclude membership from a failed run", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);
    const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: "v1", contentHash: "c".repeat(64) });

    const run = await createSynthesisRun(workspaceId, baseVersion, { status: "failed", outcome: "failure" });
    await addRunMembership(workspaceId, run, itemId, "v1", "c".repeat(64));

    expect(await getPending(workspaceId)).toEqual([itemId]);
  });

  test("does not exclude membership from a stale run, even with outcome 'stale'", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);
    const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: "v1", contentHash: "c".repeat(64) });

    const run = await createSynthesisRun(workspaceId, baseVersion, { status: "stale", outcome: "stale" });
    await addRunMembership(workspaceId, run, itemId, "v1", "c".repeat(64));

    expect(await getPending(workspaceId)).toEqual([itemId]);
  });

  test("does not exclude membership from a still-running (non-terminal) run", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);
    const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: "v1", contentHash: "c".repeat(64) });

    const run = await createSynthesisRun(workspaceId, baseVersion, { status: "running", outcome: null });
    await addRunMembership(workspaceId, run, itemId, "v1", "c".repeat(64));

    expect(await getPending(workspaceId)).toEqual([itemId]);
  });

  test("a superseding revision (new version/hash) is pending again even though a prior revision was consumed", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);

    // Simulate: v1 was synthesized successfully, then the source changed to v2
    // (upsert_source_item would supersede v1's row and insert a new active v2
    // row with the same item id conceptually -- here we model it directly as
    // one active row whose current version/hash was never itself consumed).
    const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: "v2", contentHash: "d".repeat(64) });

    const run = await createSynthesisRun(workspaceId, baseVersion, { status: "succeeded", outcome: "changed" });
    // The run consumed the OLD version/hash, not the current one.
    await addRunMembership(workspaceId, run, itemId, "v1", "c".repeat(64));

    expect(await getPending(workspaceId)).toEqual([itemId]);
  });

  test("only considers active lifecycle_status sources", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);

    await insertSourceItem(workspaceId, connectionId, { lifecycleStatus: "superseded" });
    await insertSourceItem(workspaceId, connectionId, { lifecycleStatus: "received" });
    const active = await insertSourceItem(workspaceId, connectionId, { lifecycleStatus: "active" });

    expect(await getPending(workspaceId)).toEqual([active]);
  });

  test("reprocess=true bypasses the successful-membership exclusion", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);
    const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: "v1", contentHash: "c".repeat(64) });

    const run = await createSynthesisRun(workspaceId, baseVersion, { status: "succeeded", outcome: "changed" });
    await addRunMembership(workspaceId, run, itemId, "v1", "c".repeat(64));

    expect(await getPending(workspaceId, false)).toEqual([]);
    expect(await getPending(workspaceId, true)).toEqual([itemId]);
  });

  test("consumed sources remain searchable (active) after successful synthesis", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);
    const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: "v1", contentHash: "c".repeat(64) });

    const run = await createSynthesisRun(workspaceId, baseVersion, { status: "succeeded", outcome: "changed" });
    await addRunMembership(workspaceId, run, itemId, "v1", "c".repeat(64));

    expect(await getPending(workspaceId)).toEqual([]);

    const [row] = await db()<[{ lifecycle_status: string }]>`
      select lifecycle_status from source_items where id = ${itemId}
    `;
    expect(row.lifecycle_status).toBe("active");
  });

  test("the source-first composite index supports the successful-membership anti-join without a sequential scan", async () => {
    const { workspaceId } = await createWorkspace();
    const connectionId = await createConnection(workspaceId);
    const baseVersion = await createBaseContextVersion(workspaceId);

    // Enough rows that the planner's cost model would consider a seq scan if
    // the index weren't usable for this access pattern.
    let targetItemId = "";
    for (let i = 0; i < 50; i++) {
      const hash = i.toString().repeat(64).slice(0, 64);
      const itemId = await insertSourceItem(workspaceId, connectionId, { externalVersion: `v${i}`, contentHash: hash });
      const run = await createSynthesisRun(workspaceId, baseVersion, { status: "succeeded", outcome: "changed" });
      await addRunMembership(workspaceId, run, itemId, `v${i}`, hash);
      if (i === 0) targetItemId = itemId;
    }

    await db()`set local enable_seqscan = off`;
    const [plan] = await db()<[{ "QUERY PLAN": unknown }]>`
      explain (format json)
      select 1
      from synthesis_run_source_items srsi
      join synthesis_runs sr
        on sr.id = srsi.synthesis_run_id and sr.workspace_id = srsi.workspace_id
      where srsi.workspace_id = ${workspaceId}
        and srsi.source_item_id = ${targetItemId}
        and srsi.source_item_version = 'v0'
        and srsi.content_hash = ${"0".repeat(64)}
        and sr.status = 'succeeded'
        and sr.outcome in ('changed', 'no_change')
    `;
    const planJson = plan["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>;
    const planText = JSON.stringify(planJson);
    expect(planText).toContain("synthesis_run_source_items_source_item_idx");
    expect(planText).not.toContain("Seq Scan");
  });
});
