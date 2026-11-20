import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRunSpec } from "draft-core/run-spec";
import type { ScheduledTaskRow } from "../types/tables";
import { effectiveBuiltInTools, parseAgentRoutineConfig, type AgentRoutineConfig } from "./config";

/** A routine a person made is level 0. A run at level 3 can't make another routine. */
export const ROUTINE_MAX_DEPTH = 3;
/** Pending one-shots that agents made, per workspace. */
export const MAX_PENDING_AGENT_ONE_SHOTS = 20;
/** Enough steps to pass the deepest chain (ROUTINE_MAX_DEPTH) and one more. */
const CHAIN_STEPS = 4;

export interface ParentRoutine {
  task: ScheduledTaskRow;
  config: AgentRoutineConfig;
}

/** The access a routine holds. A run may give a routine no more than it holds itself. */
export type RoutineAccess = Pick<AgentRoutineConfig, "canNotify" | "postChannels" | "github"> & Partial<Pick<AgentRoutineConfig, "harness" | "builtInTools" | "toolset">>;

async function runTaskId(client: SupabaseClient, runId: string, workspaceId: string): Promise<string | null> {
  const { data, error } = await client.from("agent_runs").select("scheduled_task_id").eq("id", runId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  return (data as { scheduled_task_id: string | null } | null)?.scheduled_task_id ?? null;
}

async function loadTask(client: SupabaseClient, workspaceId: string, taskId: string): Promise<ScheduledTaskRow | null> {
  const { data, error } = await client.from("scheduled_tasks").select("*").eq("id", taskId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  return (data as ScheduledTaskRow | null) ?? null;
}

/** The routine that started this run, or null when no routine did. Throws when the routine is missing or stored wrongly. */
export async function loadParentRoutine(client: SupabaseClient, run: AgentRunSpec): Promise<ParentRoutine | null> {
  const taskId = await runTaskId(client, run.id, run.workspaceId);
  if (!taskId) return null;
  const task = await loadTask(client, run.workspaceId, taskId);
  if (!task) throw new Error(`Routine ${taskId} of run ${run.id} was not found`);
  const config = parseAgentRoutineConfig(task.config_json);
  if (!config) throw new Error(`Routine ${taskId} has a stored config that is not a valid agent routine`);
  return { task, config };
}

/** Private when any event that woke the run came from a private source. Otherwise shared. */
export async function runVisibility(client: SupabaseClient, runId: string): Promise<"private" | "shared"> {
  const { data: events, error: eventError } = await client.from("agent_event_inbox").select("source_item_id").eq("claimed_by_run_id", runId);
  if (eventError) throw eventError;
  const sourceIds = ((events ?? []) as Array<{ source_item_id: string | null }>).map((event) => event.source_item_id).filter((id): id is string => id !== null);
  if (sourceIds.length === 0) return "shared";

  const { data: privateItems, error: itemError } = await client.from("source_items").select("id").in("id", sourceIds).eq("visibility", "private").limit(1);
  if (itemError) throw itemError;
  return (privateItems ?? []).length > 0 ? "private" : "shared";
}

/**
 * A run may change only a routine its own chain made: one a run of this run's routine made, or one made by
 * a run that a chain of such runs made. Never a routine a person made.
 */
export async function runMayManage(client: SupabaseClient, run: AgentRunSpec, task: ScheduledTaskRow): Promise<boolean> {
  if (task.created_via !== "run") return false;
  const ownTaskId = await runTaskId(client, run.id, run.workspaceId);
  let current: ScheduledTaskRow | null = task;
  for (let step = 0; step < CHAIN_STEPS && current?.created_via === "run" && current.created_by_run_id; step += 1) {
    if (current.created_by_run_id === run.id) return true;
    const madeByTaskId = await runTaskId(client, current.created_by_run_id, run.workspaceId);
    if (!madeByTaskId) return false;
    if (madeByTaskId === ownTaskId) return true;
    current = await loadTask(client, run.workspaceId, madeByTaskId);
  }
  return false;
}

const channelKey = (value: string) => value.replace(/^#/, "").toLowerCase();
const repoKey = (value: string) => value.toLowerCase();

function isSubset(values: readonly string[], allowed: readonly string[], key: (value: string) => string): boolean {
  const keys = new Set(allowed.map(key));
  return values.every((value) => keys.has(key(value)));
}

/** The first access setting the child gives that the parent does not hold, or null when none is wider. */
export function widerAccess(parent: RoutineAccess | null, child: RoutineAccess): string | null {
  if (child.canNotify && !parent?.canNotify) return "canNotify";
  if (child.postChannels !== undefined) {
    const allowed = parent?.postChannels;
    const wider = allowed === undefined || (allowed !== "joined" && (child.postChannels === "joined" || !isSubset(child.postChannels, allowed, channelKey)));
    if (wider) return "postChannels";
  }
  // A run's own routine bounds the built-in tools it can give. A run with no routine, such as a cloud session, acts for its owner.
  if (child.builtInTools && parent?.harness && child.harness === parent.harness && !isSubset(child.builtInTools, effectiveBuiltInTools({ harness: parent.harness, builtInTools: parent.builtInTools, toolset: parent.toolset }), (value) => value)) {
    return "builtInTools";
  }
  if (child.github) {
    const allowed = parent?.github;
    const wider = !allowed || !isSubset(child.github.repos, allowed.repos, repoKey) || (child.github.access === "write" && allowed.access === "read");
    if (wider) return "github";
  }
  return null;
}

/** How many one-shots agents made are waiting to fire. A fired one-shot is not counted. */
export async function pendingAgentOneShots(client: SupabaseClient, workspaceId: string): Promise<number> {
  const { count, error } = await client
    .from("scheduled_tasks")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("schedule_kind", "once")
    .is("fired_at", null)
    .is("deleted_at", null)
    .in("created_via", ["mcp", "run"]);
  if (error) throw error;
  return count ?? 0;
}
