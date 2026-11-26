import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentRunSpec } from "draft-core/run-spec";
import { resolveBaseContextVersionId } from "../../metaharness/runs/base-context";
import { buildHomeRunSpec } from "./spec";

export interface HomeSessionRef {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  model: string | null;
}

/** The columns `open_home_run` saves, from a spec. */
export function runRowOf(spec: AgentRunSpec, sessionId: string): Record<string, unknown> {
  return {
    id: spec.id,
    workspace_id: spec.workspaceId,
    kind: spec.kind,
    trigger: spec.trigger,
    on_behalf_of_user_id: spec.onBehalfOf,
    execution: spec.execution,
    toolset: spec.toolset,
    computer: spec.computer,
    continuation: spec.continuation ?? null,
    harness: spec.harness,
    model: spec.model,
    reasoning_effort: spec.reasoningEffort ?? null,
    instructions: spec.instructions,
    base_context_version_id: spec.inputs.contextVersionId,
    permissions: spec.permissions,
    output: spec.output,
    idempotency_key: `home:${sessionId}:${spec.id}`,
  };
}

/**
 * Opens the run of a work episode, or joins the one already open, and returns its id. The database takes the session lock for
 * both this and settling, so an input never joins a run that is closing.
 */
export async function openHomeRun(client: SupabaseClient, session: HomeSessionRef, instructions: string): Promise<string> {
  const spec = buildHomeRunSpec({
    runId: randomUUID(),
    workspaceId: session.workspaceId,
    ownerUserId: session.ownerUserId,
    sessionId: session.id,
    model: session.model,
    contextVersionId: await resolveBaseContextVersionId(client, session.workspaceId),
    instructions,
  });
  const { data, error } = await client.rpc("open_home_run", { p_session_id: session.id, p_row: runRowOf(spec, session.id) });
  if (error) throw error;
  return data as string;
}

/** Ends the run when no work is pending. False means work is still pending and the run stays open. */
export async function settleHomeRun(client: SupabaseClient, sessionId: string, runId: string, status: "succeeded" | "failed" | "cancelled" = "succeeded"): Promise<boolean> {
  const { data, error } = await client.rpc("settle_home_run", { p_session_id: sessionId, p_run_id: runId, p_status: status });
  if (error) throw error;
  return data === true;
}

/** The open run of a Home session, if any. */
export async function activeHomeRunId(client: SupabaseClient, sessionId: string): Promise<string | null> {
  const { data, error } = await client.from("agent_runs").select("id").eq("session_id", sessionId).in("status", ["queued", "preparing", "running", "validating", "committing"]).maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}
