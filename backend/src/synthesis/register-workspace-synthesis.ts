import { CronExpressionParser } from "cron-parser";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScheduledTaskRow } from "../types/tables";

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
  const db = client ?? (await import("../db/client")).serviceClient;

  const nextDueAt = CronExpressionParser.parse(SYNTHESIS_SCHEDULE_CRON, {
    currentDate: new Date(),
    tz: SYNTHESIS_SCHEDULE_TIMEZONE,
  })
    .next()
    .toDate();

  const { error } = await db.from("scheduled_tasks").upsert(
    {
      workspace_id: workspace.id,
      source_connection_id: null,
      task_type: "synthesize_workspace",
      task_key: workspace.id,
      schedule_kind: "cron",
      cron_expression: SYNTHESIS_SCHEDULE_CRON,
      interval_seconds: null,
      timezone: SYNTHESIS_SCHEDULE_TIMEZONE,
      enabled: true,
      next_due_at: nextDueAt.toISOString(),
    } satisfies Partial<ScheduledTaskRow>,
    { onConflict: "workspace_id,task_type,task_key" },
  );
  if (error) throw error;
}
