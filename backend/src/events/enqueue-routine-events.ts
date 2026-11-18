import type { SupabaseClient } from "@supabase/supabase-js";
import { ROUTINE_TRIGGERS } from "draft-core/routines";
import { recordError } from "../errors/record-error";
import { parseAgentRoutineConfig, type RoutineEventName } from "../routines/config";
import { eventIdempotencyKey, type RoutineEventPayload } from "../routines/event";
import type { EventFact } from "../routines/event-facts";
import type { ScheduledTaskRow, SourceItemRow } from "../types/tables";
import { drainEventInbox } from "./drain";
import { enqueueEvent } from "./enqueue";

const MAX_EVENT_TEXT_CHARS = 20_000;

export interface StartEventRoutinesInput {
  workspaceId: string;
  name: RoutineEventName;
  /** The provider's id for the event, such as the meeting id. */
  eventId: string;
  /** The source item the event produced. Its content goes to the run, if the routine's owner may see it. */
  sourceItemId: string;
  /** Ids, links and refs from the provider's payload, so the agent can act on the event. */
  facts?: EventFact[];
}

type EventSource = Pick<SourceItemRow, "content_markdown" | "metadata_json" | "visibility" | "owner_user_id">;

/**
 * Adds the event to the inbox once for each enabled routine that asked for it, then starts one drain.
 * A routine whose owner cannot see the source gets the event marked skipped. Returns how many were added.
 */
export async function enqueueRoutineEvents(
  client: SupabaseClient,
  input: StartEventRoutinesInput & { concurrencyKey: string },
  deps: { drain?: () => Promise<void> } = {},
): Promise<number> {
  const { data: tasks, error } = await client
    .from("scheduled_tasks")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("task_type", "agent_routine")
    .eq("enabled", true)
    .is("deleted_at", null);
  if (error) throw error;

  const matching = ((tasks ?? []) as ScheduledTaskRow[]).filter((task) => parseAgentRoutineConfig(task.config_json)?.events?.includes(input.name));
  if (matching.length === 0) return 0;

  const { data: sourceData, error: sourceError } = await client
    .from("source_items")
    .select("content_markdown, metadata_json, visibility, owner_user_id")
    .eq("id", input.sourceItemId)
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();
  if (sourceError) throw sourceError;
  if (!sourceData) throw new Error(`Source item ${input.sourceItemId} was not found in workspace ${input.workspaceId}`);
  const source = sourceData as EventSource;
  if (!source.content_markdown) return 0;

  const title = typeof source.metadata_json?.title === "string" ? source.metadata_json.title : "Untitled";
  const trigger = ROUTINE_TRIGGERS.find((entry) => entry.event === input.name);
  const description = trigger?.description ?? input.name;
  const providerLabel = trigger?.providerLabel ?? input.name;
  const event: RoutineEventPayload = {
    name: input.name,
    eventId: input.eventId,
    description,
    providerLabel,
    sourceItemId: input.sourceItemId,
    facts: input.facts ?? [],
    title,
    text: source.content_markdown.slice(0, MAX_EVENT_TEXT_CHARS),
    truncated: source.content_markdown.length > MAX_EVENT_TEXT_CHARS,
  };
  // Anyone who can see the routine sees this note, so it never names the private source.
  const hidden = {
    code: "routine_source_not_visible",
    note: `Skipped: ${description}, but that ${providerLabel} item is private, and this routine's owner can't see it. A routine only reads what its owner can see.`,
  };

  let enqueued = 0;
  for (const task of matching) {
    // The run is on behalf of the routine's owner, so it may only read what the owner may read.
    const ownerMaySee = source.visibility === "shared" || (!!task.created_by_user_id && source.owner_user_id === task.created_by_user_id);
    try {
      const { duplicate } = await enqueueEvent(
        client,
        {
          workspaceId: input.workspaceId,
          scheduledTaskId: task.id,
          origin: "webhook",
          eventName: input.name,
          dedupeKey: eventIdempotencyKey(task.id, { name: input.name, eventId: input.eventId }),
          concurrencyKey: input.concurrencyKey,
          sourceItemId: input.sourceItemId,
          payload: { type: "webhook", event, ...(ownerMaySee ? {} : { skip: hidden }) },
        },
        { drain: async () => {} },
      );
      if (!duplicate) enqueued += 1;
    } catch (cause) {
      await recordError({
        client,
        workspaceId: input.workspaceId,
        scheduledTaskId: task.id,
        operation: "scheduling",
        message: "A routine event could not be queued",
        code: "event_enqueue_failed",
        error: cause,
        detail: { event: input.name, event_id: input.eventId },
      });
    }
  }

  // One drain covers every row added above. It runs in the background, and its failure is recorded.
  void (deps.drain ?? drainEventInbox)().catch((cause) =>
    recordError({ client, workspaceId: input.workspaceId, operation: "scheduling", message: "Draining the event inbox failed", code: "event_drain_failed", error: cause }),
  );
  return enqueued;
}

/**
 * Queues the routine events for a webhook, after the webhook has stored its source. The provider gets its answer
 * first, and a failed enqueue is recorded instead of failing the webhook.
 */
export function fireEnqueueRoutineEvents(input: StartEventRoutinesInput & { concurrencyKey: string; sourceConnectionId: string }): void {
  const { sourceConnectionId, ...enqueue } = input;
  void (async () => {
    // Loaded lazily, so importing this module does not need the database env.
    const { serviceClient } = await import("../db/client");
    await enqueueRoutineEvents(serviceClient, enqueue);
  })().catch((cause) =>
    recordError({ workspaceId: input.workspaceId, sourceConnectionId, operation: "scheduling", message: "Queueing routine events failed", code: "event_enqueue_failed", error: cause }),
  );
}
