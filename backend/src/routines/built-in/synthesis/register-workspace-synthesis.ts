import type { SupabaseClient } from "@supabase/supabase-js";
import { registerBuiltInTask } from "../../built-in-task";

// Hourly 9am-6pm UTC, ~4h spacing overnight (fixed UTC approximation of
// "work hours" -- no per-workspace timezone column exists yet).
export const SYNTHESIS_SCHEDULE_CRON = "0 0,4,8,9-18,22 * * *";
const SYNTHESIS_SCHEDULE_TIMEZONE = "UTC";

export interface CreateInitialWorkspaceSynthesisWorkspace {
  id: string;
}

// Always creates the row regardless of credential/connection state --
// checkRunAllowed and dispatchSynthesizeWorkspace already no-op cleanly at
// dispatch time when a workspace isn't ready. Idempotent, safe to re-call.
export async function createInitialWorkspaceSynthesis(
  workspace: CreateInitialWorkspaceSynthesisWorkspace,
  client?: SupabaseClient,
): Promise<void> {
  const db = client ?? (await import("../../../db/client")).serviceClient;
  await registerBuiltInTask(db, {
    workspaceId: workspace.id,
    taskType: "synthesize_workspace",
    cron: SYNTHESIS_SCHEDULE_CRON,
    timezone: SYNTHESIS_SCHEDULE_TIMEZONE,
  });
}
