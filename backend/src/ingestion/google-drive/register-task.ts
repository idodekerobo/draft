import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScheduledTaskRow } from "../../types/tables";

const DRIVE_SYNC_INTERVAL_SECONDS = 120;

export interface RegisterDriveSyncTaskConnection {
  id: string;
  workspace_id: string;
}

// Due now, so the first sync starts on the next scheduler tick after connect.
export async function registerDriveSyncTask(
  connection: RegisterDriveSyncTaskConnection,
  client?: SupabaseClient,
): Promise<void> {
  const db = client ?? (await import("../../db/client")).serviceClient;
  const { error } = await db.from("scheduled_tasks").upsert(
    {
      workspace_id: connection.workspace_id,
      connection_id: connection.id,
      task_type: "ingest_source",
      task_key: connection.id,
      schedule_kind: "interval",
      interval_seconds: DRIVE_SYNC_INTERVAL_SECONDS,
      cron_expression: null,
      timezone: "UTC",
      enabled: true,
      next_due_at: new Date().toISOString(),
    } satisfies Partial<ScheduledTaskRow>,
    { onConflict: "workspace_id,task_type,task_key" },
  );
  if (error) throw error;
}
