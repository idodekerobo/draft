import type { SupabaseClient } from "@supabase/supabase-js";
import type { SynthesisFinalResult } from "./types";

/** The agent's answer cannot be accepted. Final: the run fails. Any other error is a database problem and may be retried. */
export class InvalidSynthesisResultError extends Error {}

export function parseFinalResult(raw: unknown): SynthesisFinalResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new InvalidSynthesisResultError("synthesis result must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.outcome !== "changed" && obj.outcome !== "no_change") {
    throw new InvalidSynthesisResultError(`invalid outcome: ${String(obj.outcome)}`);
  }
  if (typeof obj.summary !== "string" || !obj.summary.trim()) {
    throw new InvalidSynthesisResultError("summary must be a nonempty string");
  }
  if (obj.needs_input !== undefined && !Array.isArray(obj.needs_input)) {
    throw new InvalidSynthesisResultError("needs_input must be an array");
  }
  return {
    outcome: obj.outcome,
    summary: obj.summary,
    needs_input: obj.needs_input as SynthesisFinalResult["needs_input"],
  };
}

/**
 * Ends a synthesis run whose documents were written through context.write. What counts is what really
 * landed in the database, not what the agent says. An agent that claims a change without a landed write
 * fails the run: a production run once claimed changes it never made.
 */
export async function finalizeSynthesisResult(
  runId: string,
  rawResult: unknown,
  client?: SupabaseClient,
): Promise<{ outcome: "changed" | "no_change" }> {
  const result = parseFinalResult(rawResult);
  const db = client ?? (await import("../db/client")).serviceClient;

  const { data, error } = await db
    .from("workspace_context_versions")
    .select("content_hash, version_number")
    .eq("agent_run_id", runId)
    .order("version_number", { ascending: false });
  if (error) throw error;
  const landed = (data ?? []) as Array<{ content_hash: string; version_number: number }>;

  if (result.outcome === "changed" && landed.length === 0) {
    throw new InvalidSynthesisResultError("outcome=changed but no document was written to the context");
  }

  const outcome = landed.length > 0 ? "changed" : "no_change";
  const { error: rpcError } = await db.rpc("finalize_synthesis_run", {
    p_run_id: runId,
    p_outcome: outcome,
    p_summary: result.summary,
    p_result_hash: landed[0]?.content_hash ?? null,
    p_needs_input_json: result.needs_input ?? null,
  });
  if (rpcError) throw rpcError;
  return { outcome };
}
