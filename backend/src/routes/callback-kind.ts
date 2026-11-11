import type { SupabaseClient } from "@supabase/supabase-js";
import { SUMMARIZATION_RUN_ID_PREFIX } from "../summarization/complete-summarization-callback";
import { ROUTINE_RUN_ID_PREFIX } from "../routines/config";

export type CallbackKind = "synthesis" | "routine" | "summarization";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: ReadonlyArray<string> = ["synthesis", "routine", "summarization"];

/**
 * Which handler a sandbox callback belongs to. The run id the sandbox reports under is the agent run's id,
 * so the run's kind decides. An id in the older prefixed form (`routine:` or `summarize:`) still routes by its
 * prefix, so a run that started before this was deployed can finish.
 */
export async function callbackKind(runId: string, client: SupabaseClient): Promise<CallbackKind> {
  if (runId.startsWith(ROUTINE_RUN_ID_PREFIX)) return "routine";
  if (runId.startsWith(SUMMARIZATION_RUN_ID_PREFIX)) return "summarization";
  if (UUID.test(runId)) {
    const { data, error } = await client.from("agent_runs").select("kind").eq("id", runId).maybeSingle();
    if (error) throw error;
    const kind = (data as { kind: string } | null)?.kind;
    if (kind && KINDS.includes(kind)) return kind as CallbackKind;
  }
  // Not a run Draft knows. The synthesis handler answers it the way it always has.
  return "synthesis";
}
