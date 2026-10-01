import { CronExpressionParser } from "cron-parser";
import type { SupabaseClient } from "@supabase/supabase-js";

export const SESSION_SUMMARY_CRON = "0 3 * * *";

export async function registerSessionSummaryTask(workspaceId: string, client: SupabaseClient): Promise<void> {
  const { data: workspace, error: workspaceError } = await client.from("workspaces")
    .select("timezone").eq("id", workspaceId).single();
  if (workspaceError) throw workspaceError;
  const timezone = workspace.timezone || "UTC";
  const { data: existing, error: lookupError } = await client.from("scheduled_tasks")
    .select("id").eq("workspace_id", workspaceId).eq("task_type", "summarize_sessions").maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) {
    const { error } = await client.from("scheduled_tasks").update({ enabled: true }).eq("id", existing.id);
    if (error) throw error;
    return;
  }
  const { error } = await client.from("scheduled_tasks").upsert({
    workspace_id: workspaceId,
    task_type: "summarize_sessions",
    task_key: workspaceId,
    schedule_kind: "cron",
    cron_expression: SESSION_SUMMARY_CRON,
    timezone,
    enabled: true,
    next_due_at: CronExpressionParser.parse(SESSION_SUMMARY_CRON, { tz: timezone }).next().toDate().toISOString(),
  }, { onConflict: "workspace_id,task_type,task_key", ignoreDuplicates: true });
  if (error) throw error;
}
