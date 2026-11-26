import type { SupabaseClient } from "@supabase/supabase-js";
import type { RunUsage } from "draft-core/run-usage";

/**
 * Saves what a harness reported for a run. Bookkeeping only: a failure is logged and never
 * changes how the run ends. Does nothing when the runner sent no usage (an older image).
 */
export async function saveRunUsage(
  client: SupabaseClient,
  target: { runId: string } | { sessionId: string },
  usage: RunUsage | undefined,
): Promise<void> {
  if (!usage) return;
  try {
    const query = client.from("agent_runs").update({ usage_json: usage });
    const { error } = "runId" in target
      ? await query.eq("id", target.runId)
      : await query.eq("session_id", target.sessionId).eq("kind", "routine");
    if (error) console.error(JSON.stringify({ source: "save_run_usage", event: "update_failed", error: String(error.message ?? error) }));
  } catch (error) {
    console.error(JSON.stringify({ source: "save_run_usage", event: "update_threw", error: String(error) }));
  }
}
