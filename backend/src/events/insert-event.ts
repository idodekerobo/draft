import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkspaceEventType } from "../types/enums";

// TODO: read-then-insert sequence_number has a race under concurrent
// writers. Fine for this single-operator run; replace with a locking
// RPC/transaction before anything else can write concurrently.
export async function insertEvent(
  client: SupabaseClient,
  workspaceId: string,
  fields: {
    event_type: WorkspaceEventType;
    summary: string;
    synthesis_run_id?: string | null;
    source_connection_id?: string | null;
    context_version_id?: string | null;
    payload_json?: Record<string, unknown>;
  },
): Promise<void> {
  const { data: last, error: lastError } = await client
    .from("workspace_events")
    .select("sequence_number")
    .eq("workspace_id", workspaceId)
    .order("sequence_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;
  const nextSequence = (last?.sequence_number ?? 0) + 1;
  const { error } = await client.from("workspace_events").insert({
    workspace_id: workspaceId,
    sequence_number: nextSequence,
    event_type: fields.event_type,
    synthesis_run_id: fields.synthesis_run_id ?? null,
    source_connection_id: fields.source_connection_id ?? null,
    context_version_id: fields.context_version_id ?? null,
    summary: fields.summary,
    payload_json: fields.payload_json ?? {},
    occurred_at: new Date().toISOString(),
  });
  if (error) throw error;
}
