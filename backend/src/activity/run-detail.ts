import type { SupabaseClient } from "@supabase/supabase-js";
import { sumRunUsage, parseRunUsage, type RunUsage } from "draft-core/run-usage";
import { ACTIVE_AGENT_RUN_STATUSES } from "draft-core/run-spec";
import { eventsForAdapter } from "../ingestion/harness-lines";
import { eventLine } from "../routines/run-detail";
import { stepsOfParent } from "../routines/workflow/step-run-spec";
import type { AgentRunRow } from "../types/tables";
import { loadRoutineTasks, titleOf, viewerMaySee } from "./service";

export type StepStatus = "waiting" | "running" | "done" | "failed" | "skipped" | "not_run";

export interface StepRunDetail {
  id: string;
  status: AgentRunRow["status"];
  attempt: number;
  /** Names the item the run worked on, such as a document path or "Sources 3". Empty for a step that runs once. */
  label: string;
  startedAt: string | null;
  completedAt: string | null;
  summary: string | null;
  failureCode: string | null;
  usage: RunUsage | null;
  /** Documents this run wrote, by path. */
  documentsChanged: string[];
  hasTranscript: boolean;
}

export interface RunStepDetail {
  key: string;
  status: StepStatus;
  runs: StepRunDetail[];
}

export interface RunDetail {
  id: string;
  kind: AgentRunRow["kind"];
  status: AgentRunRow["status"];
  outcome: AgentRunRow["outcome"];
  summary: string | null;
  routineId: string | null;
  routineTitle: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failureCode: string | null;
  /** The key of the step that failed the run, when one did. */
  failedStep: string | null;
  usage: RunUsage | null;
  documentsChanged: string[];
  steps: RunStepDetail[];
}

export type RunDetailResult = { ok: true; detail: RunDetail } | { ok: false };

const isActive = (status: string): boolean => (ACTIVE_AGENT_RUN_STATUSES as ReadonlyArray<string>).includes(status);

/** A run the viewer may open: a routine's or synthesis's own run, in this workspace, of a routine they may see. */
async function loadVisibleParent(client: SupabaseClient, workspaceId: string, runId: string, viewerId: string | null): Promise<AgentRunRow | null> {
  const { data, error } = await client.from("agent_runs").select("*").eq("workspace_id", workspaceId).eq("id", runId).in("kind", ["synthesis", "routine"]).is("parent_run_id", null).maybeSingle();
  if (error) throw error;
  const run = data as AgentRunRow | null;
  if (!run) return null;
  if (run.scheduled_task_id) {
    const [task] = await loadRoutineTasks(client, workspaceId, [run.scheduled_task_id]);
    if (task && !viewerMaySee(task, viewerId)) return null;
  }
  return run;
}

/** The documents each run wrote: the paths whose text differs from the version before. */
async function documentsChangedByRun(client: SupabaseClient, runIds: string[]): Promise<Map<string, string[]>> {
  const byRun = new Map<string, Set<string>>();
  if (runIds.length === 0) return new Map();
  const { data, error } = await client.from("workspace_context_versions").select("agent_run_id, previous_version_id, documents_json").in("agent_run_id", runIds);
  if (error) throw error;
  const versions = (data ?? []) as Array<{ agent_run_id: string; previous_version_id: string | null; documents_json: Record<string, { sha256: string }> }>;
  const previousIds = [...new Set(versions.flatMap((version) => (version.previous_version_id ? [version.previous_version_id] : [])))];
  const previous = new Map<string, Record<string, { sha256: string }>>();
  if (previousIds.length > 0) {
    const { data: rows, error: previousError } = await client.from("workspace_context_versions").select("id, documents_json").in("id", previousIds);
    if (previousError) throw previousError;
    for (const row of (rows ?? []) as Array<{ id: string; documents_json: Record<string, { sha256: string }> }>) previous.set(row.id, row.documents_json);
  }
  for (const version of versions) {
    const before = (version.previous_version_id ? previous.get(version.previous_version_id) : undefined) ?? {};
    const paths = byRun.get(version.agent_run_id) ?? new Set<string>();
    for (const [path, document] of Object.entries(version.documents_json)) if (before[path]?.sha256 !== document.sha256) paths.add(path);
    byRun.set(version.agent_run_id, paths);
  }
  return new Map([...byRun].map(([id, paths]) => [id, [...paths].sort()]));
}

function labelOf(item: AgentRunRow["step_item"]): string {
  if (!item) return "";
  if (item.type === "document") return String(item.path ?? "");
  if (item.type === "new_documents") return "New documents";
  if (item.type === "source_batch") return `${item.sourceCount ?? "Some"} ${item.sourceCount === 1 ? "source" : "sources"}`;
  return "";
}

/** The latest attempt of each item of a step. */
function latestAttempts(runs: ReadonlyArray<AgentRunRow>): AgentRunRow[] {
  const latest = new Map<string, AgentRunRow>();
  for (const run of runs) {
    const key = run.step_item?.key ?? run.id;
    if (!latest.has(key) || latest.get(key)!.attempt < run.attempt) latest.set(key, run);
  }
  return [...latest.values()];
}

function statusOfStep(runs: ReadonlyArray<AgentRunRow>, parent: AgentRunRow, laterStepStarted: boolean): StepStatus {
  if (runs.length === 0) {
    if (isActive(parent.status)) return "waiting";
    return parent.status === "succeeded" ? "skipped" : "not_run";
  }
  const latest = latestAttempts(runs);
  if (latest.some((run) => isActive(run.status))) return "running";
  if (latest.every((run) => run.status === "succeeded")) return "done";
  // Some runs failed for good. The step still passed if the run carried on without them.
  return latest.some((run) => run.status === "succeeded") && (parent.status === "succeeded" || laterStepStarted) ? "done" : "failed";
}

/** A run of a routine with steps, with each step and the runs it started. Null when the run is not one the viewer may open. */
export async function getRunDetail(client: SupabaseClient, workspaceId: string, runId: string, viewerId: string | null): Promise<RunDetailResult> {
  const parent = await loadVisibleParent(client, workspaceId, runId, viewerId);
  if (!parent) return { ok: false };
  const { data, error } = await client.from("agent_runs").select("*").eq("parent_run_id", parent.id).order("created_at", { ascending: true });
  if (error) throw error;
  const children = (data ?? []) as AgentRunRow[];
  const changed = await documentsChangedByRun(client, [parent.id, ...children.map((child) => child.id)]);
  const [task] = parent.scheduled_task_id ? await loadRoutineTasks(client, workspaceId, [parent.scheduled_task_id]) : [];

  // A run from before steps existed has none to show.
  const planned = stepsOfParent(parent) ?? [];
  const keys = [...planned.map((step) => step.key), ...children.map((child) => child.step_key ?? "").filter((key) => key && !planned.some((step) => step.key === key))];
  const orderedKeys = [...new Set(keys)];
  const steps: RunStepDetail[] = orderedKeys.map((key, index) => {
    const runs = children.filter((child) => child.step_key === key);
    const laterStepStarted = orderedKeys.slice(index + 1).some((later) => children.some((child) => child.step_key === later));
    return {
      key,
      status: statusOfStep(runs, parent, laterStepStarted),
      runs: runs.map((run): StepRunDetail => ({
        id: run.id, status: run.status, attempt: run.attempt, label: labelOf(run.step_item),
        startedAt: run.started_at, completedAt: run.completed_at, summary: run.summary, failureCode: run.failure_code,
        usage: parseRunUsage(run.usage_json), documentsChanged: changed.get(run.id) ?? [], hasTranscript: Array.isArray(run.transcript_json) && run.transcript_json.length > 0,
      })),
    };
  });

  const usages = children.flatMap((child) => { const usage = parseRunUsage(child.usage_json); return usage ? [usage] : []; });
  const documents = [...new Set([...changed.values()].flat())].sort();
  return {
    ok: true,
    detail: {
      id: parent.id, kind: parent.kind, status: parent.status, outcome: parent.outcome, summary: parent.summary,
      routineId: parent.scheduled_task_id, routineTitle: parent.scheduled_task_id ? (task ? titleOf(task) : "Routine") : null,
      startedAt: parent.started_at, completedAt: parent.completed_at, failureCode: parent.failure_code,
      failedStep: parent.status === "failed" ? (steps.find((step) => step.status === "failed")?.key ?? null) : null,
      usage: usages.length ? sumRunUsage(usages) : null,
      documentsChanged: documents,
      steps,
    },
  };
}

const MAX_TRANSCRIPT_LINES = 400;

/** What a step run did, as plain lines: what the agent said and the tools it called. Null when the viewer may not open it. */
export async function getStepRunTranscript(client: SupabaseClient, workspaceId: string, runId: string, viewerId: string | null): Promise<{ lines: string[]; truncated: boolean } | null> {
  const { data, error } = await client.from("agent_runs").select("*").eq("workspace_id", workspaceId).eq("id", runId).eq("kind", "step").maybeSingle();
  if (error) throw error;
  const run = data as AgentRunRow | null;
  if (!run?.parent_run_id) return null;
  if (!(await loadVisibleParent(client, workspaceId, run.parent_run_id, viewerId))) return null;
  const messages = Array.isArray(run.transcript_json) ? run.transcript_json : [];
  const adapterId = (run.execution as { adapterId?: string } | null)?.adapterId;
  const lines: string[] = [];
  for (const [position, message] of messages.entries()) {
    let events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    try {
      events = adapterId ? eventsForAdapter(adapterId, { stream: "transcript", position, raw: JSON.stringify(message) }) : [];
    } catch {
      // A line the adapter cannot read is left out.
    }
    for (const event of events) {
      const text = eventLine({ seq: position, kind: event.kind, payload: event.payload });
      if (text) lines.push(text);
    }
  }
  return { lines: lines.slice(0, MAX_TRANSCRIPT_LINES), truncated: lines.length > MAX_TRANSCRIPT_LINES };
}
