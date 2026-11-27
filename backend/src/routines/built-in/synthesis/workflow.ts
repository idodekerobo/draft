import type { SupabaseClient } from "@supabase/supabase-js";
import { cloudToolsetFor, type HarnessId } from "draft-core/harnesses";
import { SANDBOX_RUN_DIRECTORY, sandboxComputer } from "draft-core/run-spec";
import { SYNTHESIS_PERMISSIONS } from "draft-core/tools";
import type { CaptureEntry, ReconcileConflict } from "./steps/definitions";
import { currentDocumentPaths } from "../../workflow/context-documents";
import { stepFiles } from "../../workflow/step-files";
import type { PlannedRun, StepOutputs, WorkflowKind } from "../../workflow/types";
import { CONTEXT_HISTORY_SCAN, documentsLastChanged } from "../../../services/context-history";
import type { AgentRunRow } from "../../../types/tables";
import { batchSources } from "./batch-sources";
import { parseFinalResult, InvalidSynthesisResultError } from "./finalize-result";
import { failSynthesisRun } from "./handle-run-failure";
import { loadValidatedRunBundle, PILOT_RUN_BUNDLE_LIMITS } from "./load-run-bundle";
import { loadSourceItemsByIds } from "./load-source-items";
import { renderCapturePrompt, renderOrganizePrompt, renderReconcilePrompt, isStablePath, contextFilesOf } from "./steps/render";
import type { DimensionHint, SynthesisFinalResult } from "./types";

const UNIQUE_VIOLATION = "23505";
const NEW_PREFIX = "new:";

/** What the synthesis run keeps on its own row, next to its steps, to plan them. */
interface SynthesisPlanExtras {
  sourceItemIds?: string[];
  dimensions?: DimensionHint[];
}

const extrasOf = (parent: { result_json: unknown }): SynthesisPlanExtras => (parent.result_json ?? {}) as SynthesisPlanExtras;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The entries of a capture run's answer. Anything that is not a well-formed entry is left out. */
export function entriesOf(result: unknown): CaptureEntry[] {
  const entries = isObject(result) && Array.isArray(result.entries) ? result.entries : [];
  return entries.flatMap((entry): CaptureEntry[] => {
    if (!isObject(entry) || typeof entry.text !== "string" || !["day", "week", "month"].includes(String(entry.period))) return [];
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
    return [{ period: entry.period as CaptureEntry["period"], text: entry.text, source_item_ids: strings(entry.source_item_ids), affects: strings(entry.affects) }];
  });
}

export function conflictsOf(result: unknown): ReconcileConflict[] {
  const conflicts = isObject(result) && Array.isArray(result.conflicts) ? result.conflicts : [];
  return conflicts.filter((conflict): conflict is ReconcileConflict => isObject(conflict) && typeof conflict.path === "string" && typeof conflict.claim === "string");
}

const captureEntries = (outputs: StepOutputs): CaptureEntry[] => (outputs.capture ?? []).flatMap((entry) => entriesOf(entry.result));

/** The documents a path in `affects` asks for: it exists as a stable document, or it asks for a new one. */
function splitAffected(entries: ReadonlyArray<CaptureEntry>, stable: ReadonlySet<string>): { existing: string[]; unknown: string[] } {
  const affected = [...new Set(entries.flatMap((entry) => entry.affects))];
  return { existing: affected.filter((path) => stable.has(path)), unknown: affected.filter((path) => !stable.has(path)) };
}

async function planCapture(client: SupabaseClient, parent: AgentRunRow, maxTokensPerBatch: number): Promise<PlannedRun[]> {
  const ids = extrasOf(parent).sourceItemIds ?? [];
  if (ids.length === 0) return [];
  const items = await loadSourceItemsByIds<{ id: string; external_version: string; content_hash: string | null; content_markdown: string | null }>(
    client, parent.workspace_id, ids, "id, external_version, content_hash, content_markdown",
  );
  // The order given is the order read: oldest first, so a channel's history reads in time.
  const sources = ids.flatMap((id) => {
    const item = items.get(id);
    return item?.content_hash && item.content_markdown !== null ? [{ id, version: item.external_version, contentHash: item.content_hash, chars: item.content_markdown.length }] : [];
  });
  return batchSources(sources, maxTokensPerBatch).map((batch, index) => ({
    item: { key: `batch-${index + 1}`, type: "source_batch" as const, sourceCount: batch.length },
    membership: batch.map((source) => ({ sourceItemId: source.id, version: source.version, contentHash: source.contentHash })),
  }));
}

async function planReconcile(client: SupabaseClient, parent: AgentRunRow, filter: "with_new_evidence" | "all_stable", outputs: StepOutputs): Promise<PlannedRun[]> {
  const entries = captureEntries(outputs);
  // With nothing captured there is nothing to check a document against.
  if (entries.length === 0) return [];
  const stable = (await currentDocumentPaths(client, parent.workspace_id)).filter(isStablePath);
  const { existing, unknown } = splitAffected(entries, new Set(stable));
  const documents = filter === "all_stable" ? stable : existing;
  const runs: PlannedRun[] = documents.map((path) => ({ item: { key: `doc:${path}`, type: "document" as const, path } }));
  if (unknown.length > 0) runs.push({ item: { key: "new-documents", type: "new_documents" as const } });
  return runs;
}

async function prepareStepRun(ctx: Parameters<WorkflowKind["prepareRun"]>[0]): Promise<{ bundle: Awaited<ReturnType<typeof loadValidatedRunBundle>>; prompt: string }> {
  const { client, parent, step, run, outputs } = ctx;
  const bundle = await loadValidatedRunBundle({ runId: run.id, runKinds: ["step"], extraFiles: stepFiles(outputs), client, limits: PILOT_RUN_BUNDLE_LIMITS });
  const lastChanged = await documentsLastChanged(client, parent.workspace_id);
  const render = { bundle, lastChanged, scanned: CONTEXT_HISTORY_SCAN, now: new Date() };

  if (step.key === "capture") return { bundle, prompt: renderCapturePrompt(step.prompt, render) };

  const entries = captureEntries(outputs);
  if (step.key === "reconcile") {
    const item = run.step_item;
    const stable = new Set(contextFilesOf(bundle).map((file) => file.logicalPath).filter(isStablePath));
    if (item?.type === "new_documents") {
      const { unknown } = splitAffected(entries, stable);
      const wanted = new Set(unknown);
      const relevant = entries.filter((entry) => entry.affects.some((path) => wanted.has(path)));
      const suggested = unknown.filter((path) => path.startsWith(NEW_PREFIX)).map((path) => path.slice(NEW_PREFIX.length));
      const bootstrapHints = stable.size === 0 ? extrasOf(parent).dimensions : undefined;
      return { bundle, prompt: renderReconcilePrompt(step.prompt, render, { type: "new_documents", suggestedPaths: suggested, bootstrapHints }, relevant) };
    }
    const path = String(item?.path ?? "");
    return { bundle, prompt: renderReconcilePrompt(step.prompt, render, { type: "document", path }, entries.filter((entry) => entry.affects.includes(path))) };
  }

  const conflicts = (outputs.reconcile ?? []).flatMap((entry) => conflictsOf(entry.result));
  const summaries = (outputs.reconcile ?? []).flatMap((entry) => (isObject(entry.result) && typeof entry.result.summary === "string" ? [entry.result.summary] : []));
  return { bundle, prompt: renderOrganizePrompt(step.prompt, render, entries, conflicts, summaries) };
}

/** The source items of the capture runs that succeeded, as the parent's own membership. The rest stay pending. */
async function consumeCapturedSources(client: SupabaseClient, parent: AgentRunRow, outputs: StepOutputs): Promise<void> {
  const runIds = (outputs.capture ?? []).map((entry) => entry.run.id);
  if (runIds.length === 0) return;
  const { data, error } = await client
    .from("agent_run_source_items")
    .select("source_item_id, source_item_version, content_hash, position, agent_run_id")
    .in("agent_run_id", runIds)
    .order("position", { ascending: true });
  if (error) throw error;
  // Batch order first, then each batch's own order, so the result does not depend on how ties in position come back.
  const batchOf = new Map(runIds.map((id, index) => [id, index]));
  const rows = ((data ?? []) as Array<{ source_item_id: string; source_item_version: string; content_hash: string; agent_run_id: string; position: number }>)
    .sort((a, b) => (batchOf.get(a.agent_run_id) ?? 0) - (batchOf.get(b.agent_run_id) ?? 0) || a.position - b.position);
  if (rows.length === 0) return;
  const { error: insertError } = await client.from("agent_run_source_items").insert(rows.map((row, position) => ({
    workspace_id: parent.workspace_id, agent_run_id: parent.id, source_item_id: row.source_item_id, position, source_item_version: row.source_item_version, content_hash: row.content_hash,
  })));
  // Another caller finishing the same run got here first. It has the rows; this one carries on to the final update.
  if (insertError && (insertError as { code?: string }).code !== UNIQUE_VIOLATION) throw insertError;
}

/** Reads of sources the run's agents tried through `sources.read`: how many worked and how many did not. */
async function sourceReadsOf(client: SupabaseClient, runIds: ReadonlyArray<string>): Promise<{ ok: number; rejected: number }> {
  const { data, error } = await client.from("agent_run_tool_calls").select("status").in("agent_run_id", runIds).eq("tool_name", "sources.read");
  if (error) throw error;
  const statuses = ((data ?? []) as Array<{ status: string }>).map((row) => row.status);
  const ok = statuses.filter((status) => status === "ok").length;
  return { ok, rejected: statuses.length - ok };
}

/** How many source batches did not succeed, once every attempt is counted. */
function failedCaptureBatches(runs: ReadonlyArray<AgentRunRow>): number {
  const latest = new Map<string, AgentRunRow>();
  for (const run of runs.filter((entry) => entry.step_key === "capture")) {
    const key = run.step_item?.key ?? run.id;
    if (!latest.has(key) || latest.get(key)!.attempt < run.attempt) latest.set(key, run);
  }
  return [...latest.values()].filter((run) => run.status !== "succeeded").length;
}

function describeOutcome(outputs: StepOutputs, runs: ReadonlyArray<AgentRunRow>): string {
  const captured = outputs.capture ?? [];
  const failed = failedCaptureBatches(runs);
  const retryNote = failed > 0 ? ` ${failed} source ${failed === 1 ? "batch" : "batches"} could not be read and stay pending for the next run.` : "";
  if (captured.length === 0) return `No new source material to read.${retryNote}`;
  return `Read the new sources; nothing needed to change.${retryNote}`;
}

/** The synthesis run's steps: capture, reconcile and organize. */
export const synthesisWorkflow: WorkflowKind = {
  kind: "synthesis",
  routinePermissions: async () => SYNTHESIS_PERMISSIONS,
  environment: async ({ parent }) => ({ toolset: cloudToolsetFor(parent.harness as HarnessId), computer: sandboxComputer("restricted", SANDBOX_RUN_DIRECTORY), model: parent.model }),

  async plan({ client, parent, step, outputs }) {
    if (step.key === "capture" && step.fanOut.over === "source_batches") return planCapture(client, parent, step.fanOut.maxTokensPerBatch);
    if (step.key === "reconcile" && step.fanOut.over === "context_documents") return planReconcile(client, parent, step.fanOut.filter, outputs);
    // Organize writes memory from the capture entries, so it has nothing to do when none came back.
    if (step.key === "organize") return captureEntries(outputs).length > 0 ? [{ item: { key: "organize", type: "none" as const } }] : [];
    return [];
  },

  prepareRun: prepareStepRun,

  async finish({ client, parent, outputs, runs }) {
    const organize = outputs.organize?.[0]?.result;
    let answer: SynthesisFinalResult | null = null;
    if (organize !== undefined) {
      try {
        answer = parseFinalResult(organize);
      } catch (error) {
        if (!(error instanceof InvalidSynthesisResultError)) throw error;
        await failSynthesisRun({ client, runId: parent.id, failureCode: "synthesis_result_invalid", operation: "validation", reason: "Synthesis result failed validation", error });
        return;
      }
    }

    // What counts is what landed in the database, not what an agent says. Every step run writes under its own run id.
    const { data, error } = await client
      .from("workspace_context_versions")
      .select("content_hash, version_number")
      .in("agent_run_id", [parent.id, ...runs.map((run) => run.id)])
      .order("version_number", { ascending: false });
    if (error) throw error;
    const landed = (data ?? []) as Array<{ content_hash: string; version_number: number }>;
    if (answer?.outcome === "changed" && landed.length === 0) {
      await failSynthesisRun({
        client, runId: parent.id, failureCode: "synthesis_result_invalid", operation: "validation", reason: "Synthesis result failed validation",
        error: new InvalidSynthesisResultError("outcome=changed but no document was written to the context"),
      });
      return;
    }

    // An agent that could not read its sources has nothing to base a "no change" on. Failing lets the run retry.
    const reads = await sourceReadsOf(client, [parent.id, ...runs.map((run) => run.id)]);
    if (reads.rejected > 0 && reads.ok === 0) {
      await failSynthesisRun({ client, runId: parent.id, failureCode: "sources_unreadable", operation: "execution", reason: "The agent could not read any of its sources, so nothing was synthesized" });
      return;
    }

    await consumeCapturedSources(client, parent, outputs);
    const outcome = landed.length > 0 ? "changed" : "no_change";
    const { error: rpcError } = await client.rpc("finalize_synthesis_run", {
      p_run_id: parent.id,
      p_outcome: outcome,
      p_summary: answer ? `${answer.summary}${failedCaptureBatches(runs) > 0 ? ` ${describeOutcome(outputs, runs)}` : ""}` : describeOutcome(outputs, runs),
      p_result_hash: landed[0]?.content_hash ?? null,
      // Only the run of the whole routine reports questions for people. A step's own needs_input is never acted on.
      p_needs_input_json: answer?.needs_input ?? null,
    });
    if (rpcError) throw rpcError;
  },

  async fail({ client, parent, code, reason, detail }) {
    return failSynthesisRun({ client, runId: parent.id, failureCode: code, operation: "execution", reason, detail });
  },
};
