import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { synthesisSteps } from "../../synthesis/steps/definitions";
import type { RoutineStep } from "draft-core/routine-steps";
import { canonicalDocumentsHash } from "../../synthesis/context-version-files";
import { stepPrompt } from "../../synthesis/steps/prompts";
import { conflictsOf, entriesOf, synthesisWorkflow } from "../../synthesis/workflow";
import type { AgentRunRow } from "../../types/tables";
import { fakeClient, fakeDb, type FakeDb } from "../routines/fake-client";

const WS = "33333333-3333-4333-8333-333333333333";
const ORG = "11111111-1111-4111-8111-111111111111";
const TEAM = "22222222-2222-4222-8222-222222222222";
const VERSION = "44444444-4444-4444-8444-444444444444";
const PARENT_ID = "55555555-5555-4555-8555-555555555555";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const doc = (content: string) => ({ content, sha256: sha(content) });

const steps = synthesisSteps({ harness: "claude", prompts: { capture: stepPrompt("capture", "Be brief."), reconcile: stepPrompt("reconcile", "Be brief."), organize: stepPrompt("organize", "Be brief.") } });
const stepOf = (key: string): RoutineStep => steps.find((entry) => entry.key === key)!;

const documents = { "company/about.md": doc("We make video tools."), "product/index.md": doc("The product."), "memory/index.md": doc("Memory."), "memory/days/2026-11-26.md": doc("Today.") };

function setup(options: { sourceItemIds?: string[]; sources?: Array<Record<string, unknown>>; documents?: Record<string, { content: string; sha256: string }>; versions?: Array<Record<string, unknown>>; dimensions?: unknown } = {}) {
  const docs = options.documents ?? documents;
  const parent = {
    id: PARENT_ID, workspace_id: WS, kind: "synthesis", status: "running", harness: "claude", model: null, attempt: 1, scheduled_task_id: null, retry_of_run_id: null, sandbox_machine_id: null,
    on_behalf_of_user_id: null, base_context_version_id: VERSION, prompt_version: "synthesis-v3", created_at: "2026-11-26T00:00:00.000Z", updated_at: "2026-11-26T00:00:00.000Z",
    result_json: { steps, sourceItemIds: options.sourceItemIds ?? [], ...(options.dimensions ? { dimensions: options.dimensions } : {}) },
  };
  const db = fakeDb({
    workspaces: [{ id: WS, organization_id: ORG, team_id: TEAM, current_context_version_id: VERSION }],
    workspace_context_versions: [{ id: VERSION, workspace_id: WS, version_number: 1, documents_json: docs, content_hash: canonicalDocumentsHash(docs), agent_run_id: null }, ...(options.versions ?? [])],
    agent_runs: [parent],
    agent_run_source_items: [],
    source_items: options.sources ?? [],
    people: [],
    errors: [],
  }, {
    rpcs: {
      finalize_synthesis_run: (args) => { const row = db.tables.agent_runs!.find((entry) => entry.id === args.p_run_id)!; Object.assign(row, { status: "succeeded", outcome: args.p_outcome, summary: args.p_summary, needs_input_json: args.p_needs_input_json }); return { data: { status: "succeeded" } }; },
      context_documents_last_changed: () => ({ data: [{ path: "company/about.md", version_id: VERSION, version_number: 1, created_at: "2026-10-06T00:00:00.000Z", creation_reason: "agent_write", agent_run_id: "99999999-9999-4999-8999-999999999999", summary: "s" }] }),
    },
    uuidTables: ["agent_runs"],
  });
  return { db, client: fakeClient(db), parent: parent as unknown as AgentRunRow & { kind: "synthesis" } };
}

const source = (id: string, chars: number, extra: Record<string, unknown> = {}) => ({ id, workspace_id: WS, external_version: "v1", content_hash: sha("x".repeat(chars)), content_markdown: "x".repeat(chars), lifecycle_status: "active", ...extra });
const entry = (text: string, affects: string[], ids: string[] = ["s1"]) => ({ period: "day", text, source_item_ids: ids, affects });
const out = (db: FakeDb, id: string, step_key: string, status: string, extra: Record<string, unknown> = {}, attempt = 1): AgentRunRow => {
  const row = { id, workspace_id: WS, kind: "step", parent_run_id: PARENT_ID, step_key, status, attempt, step_item: { key: id, type: "none" }, ...extra };
  db.tables.agent_runs!.push(row);
  return row as unknown as AgentRunRow;
};

describe("planning capture", () => {
  it("puts the sources in batches under the token budget, oldest first, each batch with its sources' version and hash", async () => {
    const ids = ["a", "b", "c"].map((letter) => `0000000${letter}-0000-4000-8000-000000000000`);
    // 50,000 tokens is 200,000 characters. Two sources of 120,000 characters do not fit together.
    const { client, parent } = setup({ sourceItemIds: ids, sources: ids.map((id) => source(id, 120_000)) });
    const planned = await synthesisWorkflow.plan({ client, parent, step: stepOf("capture"), outputs: {} });
    expect(planned.map((run) => run.item)).toEqual([{ key: "batch-1", type: "source_batch", sourceCount: 1 }, { key: "batch-2", type: "source_batch", sourceCount: 1 }, { key: "batch-3", type: "source_batch", sourceCount: 1 }]);
    expect(planned.map((run) => run.membership!.map((row) => row.sourceItemId))).toEqual([[ids[0]], [ids[1]], [ids[2]]]);
    expect(planned[0]!.membership![0]).toEqual({ sourceItemId: ids[0]!, version: "v1", contentHash: sha("x".repeat(120_000)) });
  });

  it("keeps small sources together in one batch", async () => {
    const ids = ["a", "b"].map((letter) => `0000000${letter}-0000-4000-8000-000000000000`);
    const { client, parent } = setup({ sourceItemIds: ids, sources: ids.map((id) => source(id, 100)) });
    const planned = await synthesisWorkflow.plan({ client, parent, step: stepOf("capture"), outputs: {} });
    expect(planned).toHaveLength(1);
    expect(planned[0]!.membership).toHaveLength(2);
  });

  it("plans nothing when there are no sources, and skips a source that is gone or has no text", async () => {
    const empty = setup({ sourceItemIds: [] });
    expect(await synthesisWorkflow.plan({ client: empty.client, parent: empty.parent, step: stepOf("capture"), outputs: {} })).toEqual([]);
    const gone = setup({ sourceItemIds: ["00000001-0000-4000-8000-000000000000", "00000002-0000-4000-8000-000000000000"], sources: [source("00000002-0000-4000-8000-000000000000", 10, { content_markdown: null })] });
    expect(await synthesisWorkflow.plan({ client: gone.client, parent: gone.parent, step: stepOf("capture"), outputs: {} })).toEqual([]);
  });
});

describe("planning reconcile", () => {
  const captured = (db: FakeDb, entries: unknown[]) => ({ capture: [{ run: out(db, "c1", "capture", "succeeded"), result: { summary: "s", entries } }] });

  it("checks each stable document an entry bears on, once, and not memory", async () => {
    const { client, db, parent } = setup();
    const outputs = captured(db, [entry("a", ["company/about.md"]), entry("b", ["company/about.md", "memory/days/2026-11-26.md"]), entry("c", [])]);
    const planned = await synthesisWorkflow.plan({ client, parent, step: stepOf("reconcile"), outputs });
    expect(planned.map((run) => run.item)).toEqual([{ key: "doc:company/about.md", type: "document", path: "company/about.md" }, { key: "new-documents", type: "new_documents" }]);
  });

  it("asks for new documents in one run when an entry names a path that does not exist", async () => {
    const { client, db, parent } = setup();
    const planned = await synthesisWorkflow.plan({ client, parent, step: stepOf("reconcile"), outputs: captured(db, [entry("a", ["new:sales/index.md"])]) });
    expect(planned.map((run) => run.item.type)).toEqual(["new_documents"]);
  });

  it("plans nothing when nothing was captured, or when no entry bears on a stable document", async () => {
    const { client, db, parent } = setup();
    expect(await synthesisWorkflow.plan({ client, parent, step: stepOf("reconcile"), outputs: { capture: [] } })).toEqual([]);
    expect(await synthesisWorkflow.plan({ client, parent, step: stepOf("reconcile"), outputs: captured(db, [entry("memory only", [])]) })).toEqual([]);
  });

  it("checks every stable document when the step asks for all of them", async () => {
    const { client, db, parent } = setup();
    const all = { ...stepOf("reconcile"), fanOut: { over: "context_documents" as const, filter: "all_stable" as const } };
    const planned = await synthesisWorkflow.plan({ client, parent, step: all, outputs: captured(db, [entry("a", ["company/about.md"])]) });
    expect(planned.map((run) => run.item.key)).toEqual(["doc:company/about.md", "doc:product/index.md"]);
  });
});

describe("planning organize", () => {
  it("runs once when something was captured, and not at all when nothing was", async () => {
    const { client, db, parent } = setup();
    const some = { capture: [{ run: out(db, "c1", "capture", "succeeded"), result: { entries: [entry("a", [])] } }] };
    expect((await synthesisWorkflow.plan({ client, parent, step: stepOf("organize"), outputs: some })).map((run) => run.item)).toEqual([{ key: "organize", type: "none" }]);
    expect(await synthesisWorkflow.plan({ client, parent, step: stepOf("organize"), outputs: { capture: [{ run: out(db, "c2", "capture", "succeeded"), result: { entries: [] } }] } })).toEqual([]);
  });
});

describe("what a step run is given", () => {
  async function launched(options: Parameters<typeof setup>[0], step: RoutineStep, run: Partial<AgentRunRow>, outputs: Record<string, Array<{ run: AgentRunRow; result: unknown }>> = {}, sourcesForRun: string[] = []) {
    const h = setup(options);
    const row = out(h.db, "66666666-6666-4666-8666-666666666666", step.key, "preparing", { base_context_version_id: VERSION, prompt_version: "synthesis-v3", ...run });
    h.db.tables.agent_run_source_items!.push(...sourcesForRun.map((id, position) => ({ workspace_id: WS, agent_run_id: row.id, source_item_id: id, position, source_item_version: "v1", content_hash: sha("x".repeat(50)) })));
    const prepared = await synthesisWorkflow.prepareRun({ client: h.client, parent: h.parent, step, run: row, outputs });
    return { ...prepared, db: h.db };
  }

  it("gives a capture run its batch, the context to check against, and the step prompt with the team's guidance", async () => {
    const id = "0000000a-0000-4000-8000-000000000000";
    const { bundle, prompt } = await launched({ sources: [source(id, 50)] }, stepOf("capture"), { step_item: { key: "batch-1", type: "source_batch", sourceCount: 1 } as never }, {}, [id]);
    expect(Object.keys(bundle.files).filter((path) => path.startsWith("input/sources/"))).toEqual([`input/sources/0000-${id}.md`]);
    expect(prompt).toContain("Draft context update: capture");
    expect(prompt).toContain("Be brief.");
    expect(prompt).toContain(`source_item_id: ${id}`);
    expect(prompt).toContain("- company/about.md");
    expect(prompt).toContain("last changed: 2026-10-06");
    expect(prompt).toContain("more than 300 versions ago, so it may be stale");
  });

  it("gives a reconcile run its document, how old it is, and only the entries that bear on it", async () => {
    const h = setup();
    const captureRun = out(h.db, "c1", "capture", "succeeded");
    const outputs = { capture: [{ run: captureRun, result: { entries: [entry("About changed", ["company/about.md"]), entry("Product changed", ["product/index.md"])] } }] };
    const { bundle, prompt } = await launched({}, stepOf("reconcile"), { step_item: { key: "doc:company/about.md", type: "document", path: "company/about.md" } as never }, outputs);
    expect(prompt).toContain("Draft context update: reconcile");
    expect(prompt).toContain("## The document to check\n- company/about.md");
    expect(prompt).toContain(`sha256: ${sha("We make video tools.")}`);
    expect(prompt).toContain("last changed: 2026-10-06, 50 days ago".replace("50 days ago", prompt.match(/last changed: 2026-10-06, (\d+ days ago)/)![1]!));
    expect(prompt).toContain("About changed");
    expect(prompt).not.toContain("Product changed");
    // The answers of the earlier step are files in the bundle.
    expect(Object.keys(bundle.files)).toContain("input/steps/capture/c1.json");
    expect(JSON.parse(bundle.files["input/steps/capture/c1.json"]!.content).entries).toHaveLength(2);
  });

  it("gives the run for new documents the entries that asked for them, and the first run's dimension hints", async () => {
    const h = setup({ documents: { "memory/index.md": doc("Memory.") }, dimensions: [{ dimensionName: "company", dimensionDescription: "Who we are" }] });
    const outputs = { capture: [{ run: out(h.db, "c1", "capture", "succeeded"), result: { entries: [entry("We sell video tools", ["new:company/index.md"]), entry("Other", [])] } }] };
    const row = out(h.db, "66666666-6666-4666-8666-666666666666", "reconcile", "preparing", { step_item: { key: "new-documents", type: "new_documents" }, prompt_version: "synthesis-v3", base_context_version_id: VERSION });
    const { prompt } = await synthesisWorkflow.prepareRun({ client: h.client, parent: h.parent, step: stepOf("reconcile"), run: row, outputs });
    expect(prompt).toContain("Draft context update: new documents");
    expect(prompt).toContain("company/index.md");
    expect(prompt).toContain("We sell video tools");
    expect(prompt).not.toContain('"text": "Other"');
    expect(prompt).toContain("- company: Who we are");
  });

  it("gives organize every entry, every conflict, and what reconcile did", async () => {
    const h = setup();
    const conflict = { path: "company/about.md", claim: "We are 5 people", new_claim: "We are 8 people", reason: "two sources disagree", evidence: [{ source_item_id: "s1", excerpt: "eight of us" }] };
    const outputs = {
      capture: [{ run: out(h.db, "c1", "capture", "succeeded"), result: { entries: [entry("Hired three", ["company/about.md"])] } }],
      reconcile: [{ run: out(h.db, "r1", "reconcile", "succeeded"), result: { summary: "Left about.md alone", changed: false, conflicts: [conflict] } }],
    };
    const row = out(h.db, "66666666-6666-4666-8666-666666666666", "organize", "preparing", { step_item: { key: "organize", type: "none" }, prompt_version: "synthesis-v3", base_context_version_id: VERSION });
    const { prompt, bundle } = await synthesisWorkflow.prepareRun({ client: h.client, parent: h.parent, step: stepOf("organize"), run: row, outputs });
    expect(prompt).toContain("Draft context update: organize");
    expect(prompt).toContain("Hired three");
    expect(prompt).toContain("We are 8 people");
    expect(prompt).toContain("Left about.md alone");
    expect(Object.keys(bundle.files)).toEqual(expect.arrayContaining(["input/steps/capture/c1.json", "input/steps/reconcile/r1.json"]));
  });
});

describe("finishing the run", () => {
  const withMembership = (db: FakeDb, runId: string, ids: string[]) =>
    db.tables.agent_run_source_items!.push(...ids.map((id, position) => ({ workspace_id: WS, agent_run_id: runId, source_item_id: id, position, source_item_version: "v1", content_hash: sha(id) })));
  const organized = { outcome: "no_change", summary: "Nothing needed to change.", needs_input: [] };

  it("ends the run with the answer organize gave, and consumes the sources of the capture runs that succeeded", async () => {
    const h = setup();
    const c1 = out(h.db, "c1", "capture", "succeeded"); const c2 = out(h.db, "c2", "capture", "succeeded");
    withMembership(h.db, "c1", ["s-a", "s-b"]); withMembership(h.db, "c2", ["s-c"]);
    const o1 = out(h.db, "o1", "organize", "succeeded");
    await synthesisWorkflow.finish({ client: h.client, parent: h.parent, steps, runs: [c1, c2, o1], outputs: { capture: [{ run: c1, result: { entries: [entry("x", [])] } }, { run: c2, result: { entries: [] } }], reconcile: [], organize: [{ run: o1, result: organized }] } });
    expect(h.db.tables.agent_run_source_items!.filter((row) => row.agent_run_id === PARENT_ID).map((row) => [row.source_item_id, row.position])).toEqual([["s-a", 0], ["s-b", 1], ["s-c", 2]]);
    expect(h.db.tables.agent_runs!.find((row) => row.id === PARENT_ID)).toMatchObject({ status: "succeeded", outcome: "no_change", summary: "Nothing needed to change." });
  });

  it("reports changed, with the newest hash, when any step run wrote a version, not only the run itself", async () => {
    const h = setup({ versions: [
      { id: "v2", workspace_id: WS, version_number: 2, documents_json: {}, content_hash: "a".repeat(64), agent_run_id: "r1" },
      { id: "v3", workspace_id: WS, version_number: 3, documents_json: {}, content_hash: "b".repeat(64), agent_run_id: "o1" },
    ] });
    const c1 = out(h.db, "c1", "capture", "succeeded"); const r1 = out(h.db, "r1", "reconcile", "succeeded"); const o1 = out(h.db, "o1", "organize", "succeeded");
    await synthesisWorkflow.finish({ client: h.client, parent: h.parent, steps, runs: [c1, r1, o1], outputs: { capture: [{ run: c1, result: { entries: [] } }], reconcile: [{ run: r1, result: {} }], organize: [{ run: o1, result: { ...organized, outcome: "changed" } }] } });
    const call = h.db.rpcCalls.find((entry) => entry.name === "finalize_synthesis_run")!;
    expect(call.args).toMatchObject({ p_run_id: PARENT_ID, p_outcome: "changed", p_result_hash: "b".repeat(64) });
  });

  it("fails the run when organize says it changed things but nothing landed, and consumes no sources", async () => {
    const h = setup();
    const c1 = out(h.db, "c1", "capture", "succeeded"); withMembership(h.db, "c1", ["s-a"]);
    const o1 = out(h.db, "o1", "organize", "succeeded");
    await synthesisWorkflow.finish({ client: h.client, parent: h.parent, steps, runs: [c1, o1], outputs: { capture: [{ run: c1, result: { entries: [entry("x", [])] } }], organize: [{ run: o1, result: { ...organized, outcome: "changed" } }] } });
    expect(h.db.tables.agent_runs!.find((row) => row.id === PARENT_ID)).toMatchObject({ status: "failed", failure_code: "synthesis_result_invalid" });
    expect(h.db.rpcCalls.find((entry) => entry.name === "finalize_synthesis_run")).toBeUndefined();
    expect(h.db.tables.agent_run_source_items!.filter((row) => row.agent_run_id === PARENT_ID)).toEqual([]);
  });

  it("fails the run when organize's answer is not valid", async () => {
    const h = setup();
    const o1 = out(h.db, "o1", "organize", "succeeded");
    await synthesisWorkflow.finish({ client: h.client, parent: h.parent, steps, runs: [o1], outputs: { organize: [{ run: o1, result: { outcome: "maybe" } }] } });
    expect(h.db.tables.agent_runs!.find((row) => row.id === PARENT_ID)).toMatchObject({ status: "failed", failure_code: "synthesis_result_invalid" });
  });

  it("reports only organize's questions for people, never a step's own", async () => {
    const h = setup();
    const needs = [{ question: "Which?", current_claim: "a", new_claim: "b", reason: "r", evidence: [] }];
    const c1 = out(h.db, "c1", "capture", "succeeded"); const r1 = out(h.db, "r1", "reconcile", "succeeded"); const o1 = out(h.db, "o1", "organize", "succeeded");
    await synthesisWorkflow.finish({ client: h.client, parent: h.parent, steps, runs: [c1, r1, o1], outputs: {
      capture: [{ run: c1, result: { entries: [], needs_input: [{ question: "from capture" }] } }],
      reconcile: [{ run: r1, result: { needs_input: [{ question: "from reconcile" }] } }],
      organize: [{ run: o1, result: { ...organized, needs_input: needs } }],
    } });
    expect(h.db.rpcCalls.find((entry) => entry.name === "finalize_synthesis_run")!.args.p_needs_input_json).toEqual(needs);
  });

  it("ends a run with nothing to read as no_change, and says so", async () => {
    const h = setup();
    await synthesisWorkflow.finish({ client: h.client, parent: h.parent, steps, runs: [], outputs: { capture: [], reconcile: [], organize: [] } });
    expect(h.db.tables.agent_runs!.find((row) => row.id === PARENT_ID)).toMatchObject({ status: "succeeded", outcome: "no_change", summary: "No new source material to read." });
    expect(h.db.rpcCalls.find((entry) => entry.name === "finalize_synthesis_run")!.args.p_needs_input_json).toBeNull();
  });

  it("says which source batches could not be read and stay pending, and does not consume their sources", async () => {
    const h = setup();
    const ok = out(h.db, "c1", "capture", "succeeded", { step_item: { key: "batch-1", type: "source_batch", sourceCount: 1 } }); withMembership(h.db, "c1", ["s-a"]);
    const bad1 = out(h.db, "c2", "capture", "failed", { step_item: { key: "batch-2", type: "source_batch", sourceCount: 1 } }, 1); withMembership(h.db, "c2", ["s-b"]);
    const bad2 = out(h.db, "c3", "capture", "failed", { step_item: { key: "batch-2", type: "source_batch", sourceCount: 1 } }, 2);
    await synthesisWorkflow.finish({ client: h.client, parent: h.parent, steps, runs: [ok, bad1, bad2], outputs: { capture: [{ run: ok, result: { entries: [] } }], reconcile: [], organize: [] } });
    expect(h.db.tables.agent_runs!.find((row) => row.id === PARENT_ID)!.summary).toContain("1 source batch could not be read and stay pending for the next run.");
    expect(h.db.tables.agent_run_source_items!.filter((row) => row.agent_run_id === PARENT_ID).map((row) => row.source_item_id)).toEqual(["s-a"]);
  });
});

describe("failing the run", () => {
  it("fails a synthesis run once, and returns false for one that already ended", async () => {
    const h = setup();
    expect(await synthesisWorkflow.fail({ client: h.client, parent: h.parent, code: "step_failed", reason: "Step capture failed" })).toBe(true);
    expect(h.db.tables.agent_runs!.find((row) => row.id === PARENT_ID)).toMatchObject({ status: "failed", failure_code: "step_failed", outcome: "failure" });
    expect(await synthesisWorkflow.fail({ client: h.client, parent: h.parent, code: "step_failed", reason: "again" })).toBe(false);
  });
});

describe("reading step answers", () => {
  it("keeps well-formed entries and drops the rest", () => {
    expect(entriesOf({ entries: [entry("ok", ["a.md"]), { text: 3 }, { period: "year", text: "x" }, null, { period: "week", text: "w", source_item_ids: ["s", 1], affects: "no" }] }))
      .toEqual([{ period: "day", text: "ok", source_item_ids: ["s1"], affects: ["a.md"] }, { period: "week", text: "w", source_item_ids: ["s"], affects: [] }]);
    expect(entriesOf(null)).toEqual([]);
    expect(entriesOf({ entries: "no" })).toEqual([]);
  });

  it("keeps conflicts that name a path and a claim", () => {
    expect(conflictsOf({ conflicts: [{ path: "a.md", claim: "x" }, { path: 1 }, "no"] })).toEqual([{ path: "a.md", claim: "x" }] as never);
    expect(conflictsOf(undefined)).toEqual([]);
  });
});
