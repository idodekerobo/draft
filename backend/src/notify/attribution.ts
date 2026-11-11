import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolCaller } from "draft-core/tools";

const clean = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").trim().slice(0, 80);

async function userName(client: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await client.from("users").select("display_name, email").eq("id", userId).maybeSingle();
  if (error) throw error;
  const row = data as { display_name: string | null; email: string } | null;
  return clean(row?.display_name?.trim() || row?.email?.split("@")[0] || "a teammate");
}

async function taskOfRun(client: SupabaseClient, runId: string): Promise<string | null> {
  const { data, error } = await client.from("agent_runs").select("scheduled_task_id").eq("id", runId).maybeSingle();
  if (error) throw error;
  return (data as { scheduled_task_id: string | null } | null)?.scheduled_task_id ?? null;
}

async function routineTitle(client: SupabaseClient, workspaceId: string, scheduledTaskId: string): Promise<string | null> {
  const { data, error } = await client.from("scheduled_tasks").select("config_json").eq("id", scheduledTaskId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  const title = (data as { config_json?: { title?: unknown } } | null)?.config_json?.title;
  return typeof title === "string" && title.trim() ? clean(title) : null;
}

/**
 * The first line of every message Draft sends for a caller. The gateway adds it after the model has handed over
 * its text, so a model cannot leave it out or change it. Run and owner come from the run spec, not from the model.
 */
export async function attributionLine(client: SupabaseClient, caller: ToolCaller): Promise<string> {
  if (caller.type === "user") return `Sent by ${await userName(client, caller.userId)} through Draft`;

  const { run } = caller;
  const owner = run.onBehalfOf ? await userName(client, run.onBehalfOf) : null;
  if (run.kind === "routine" && owner) {
    // A scheduled run names its task in the trigger. An event run is tied to its task through the run's own row.
    const taskId = run.trigger.type === "cron" ? run.trigger.scheduledTaskId : await taskOfRun(client, run.id);
    const title = taskId ? await routineTitle(client, run.workspaceId, taskId) : null;
    return title ? `🤖 Draft agent · running ${owner}'s "${title}" routine` : `🤖 Draft agent · running a routine for ${owner}`;
  }
  return owner ? `🤖 Draft agent · working for ${owner}` : `🤖 Draft agent · ${run.kind} run`;
}
