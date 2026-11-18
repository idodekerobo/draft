import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";
import { drainEventInbox } from "./drain";
import type { AgentEventOrigin, AgentEventPayload } from "./types";

export interface EnqueueEventInput {
  workspaceId: string;
  scheduledTaskId: string;
  origin: AgentEventOrigin;
  eventName: string;
  dedupeKey: string;
  concurrencyKey: string;
  sourceItemId?: string | null;
  payload: AgentEventPayload;
}

/**
 * Adds one event to the inbox, then starts a drain in the background. A dedupe key that
 * is already stored is not added again, and the result says so.
 */
export async function enqueueEvent(
  client: SupabaseClient,
  input: EnqueueEventInput,
  deps: { drain?: () => Promise<void> } = {},
): Promise<{ id: string | null; duplicate: boolean }> {
  const { data, error } = await client
    .from("agent_event_inbox")
    .upsert(
      {
        workspace_id: input.workspaceId,
        scheduled_task_id: input.scheduledTaskId,
        origin: input.origin,
        event_name: input.eventName,
        dedupe_key: input.dedupeKey,
        concurrency_key: input.concurrencyKey,
        source_item_id: input.sourceItemId ?? null,
        payload: input.payload,
      },
      { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw error;
  const id = (data as Array<{ id: string }> | null)?.[0]?.id ?? null;

  // A failed drain is recorded, never thrown back to the caller that enqueued the event.
  void (deps.drain ?? drainEventInbox)().catch((cause) =>
    recordError({ client, workspaceId: input.workspaceId, operation: "scheduling", code: "event_drain_failed", message: "Draining the event inbox failed", error: cause }),
  );
  return { id, duplicate: id === null };
}
