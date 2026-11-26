import { CronExpressionParser } from "cron-parser";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScheduledTaskType } from "../types/enums";
import type { ScheduledTaskRow } from "../types/tables";
import { defaultBuiltInConfig } from "./built-in-config";

export interface RegisterBuiltInTaskInput {
  workspaceId: string;
  taskType: ScheduledTaskType;
  cron: string;
  timezone: string;
  /** When the task already exists, turn it back on and change nothing else. Without this, an existing task is left as it is, even if paused. */
  reenableExisting?: boolean;
}

/**
 * Gives a workspace its scheduled task for a built-in routine, with the default settings. Safe to call again: an
 * existing task keeps the settings the team saved.
 */
export async function registerBuiltInTask(client: SupabaseClient, input: RegisterBuiltInTaskInput): Promise<void> {
  const { workspaceId, taskType, cron, timezone } = input;
  if (input.reenableExisting) {
    const { data: existing, error: lookupError } = await client.from("scheduled_tasks")
      .select("id").eq("workspace_id", workspaceId).eq("task_type", taskType).maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) {
      const { error } = await client.from("scheduled_tasks").update({ enabled: true }).eq("id", existing.id);
      if (error) throw error;
      return;
    }
  }
  const nextDueAt = CronExpressionParser.parse(cron, { currentDate: new Date(), tz: timezone }).next().toDate();
  const { error } = await client.from("scheduled_tasks").upsert(
    {
      workspace_id: workspaceId,
      connection_id: null,
      task_type: taskType,
      config_json: { ...defaultBuiltInConfig(taskType) },
      task_key: workspaceId,
      schedule_kind: "cron",
      cron_expression: cron,
      interval_seconds: null,
      timezone,
      enabled: true,
      next_due_at: nextDueAt.toISOString(),
    } satisfies Partial<ScheduledTaskRow>,
    { onConflict: "workspace_id,task_type,task_key", ignoreDuplicates: true },
  );
  if (error) throw error;
}
