import type { SupabaseClient } from "@supabase/supabase-js";
import { registerBuiltInTask } from "../../built-in-task";

export const SESSION_SUMMARY_CRON = "0 3 * * *";

export async function registerSessionSummaryTask(workspaceId: string, client: SupabaseClient): Promise<void> {
  const { data: workspace, error: workspaceError } = await client.from("workspaces")
    .select("timezone").eq("id", workspaceId).single();
  if (workspaceError) throw workspaceError;
  await registerBuiltInTask(client, {
    workspaceId,
    taskType: "summarize_sessions",
    cron: SESSION_SUMMARY_CRON,
    timezone: workspace.timezone || "UTC",
    reenableExisting: true,
  });
}
