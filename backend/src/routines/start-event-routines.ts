import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";
import type { SandboxDeploymentConfig } from "../sandbox";
import type { ScheduledTaskRow, SourceItemRow } from "../types/tables";
import { parseAgentRoutineConfig, type RoutineEventName } from "./config";
import { dispatchAgentRoutine } from "./dispatch-routine";
import type { RoutineEventPayload } from "./event";

const MAX_EVENT_TEXT_CHARS = 20_000;

export interface StartEventRoutinesInput {
  workspaceId: string;
  name: RoutineEventName;
  /** The provider's id for the event, such as the meeting id. */
  eventId: string;
  /** The source item the event produced. Its content goes to the run, if the routine's owner may see it. */
  sourceItemId: string;
}

type EventSource = Pick<SourceItemRow, "content_markdown" | "metadata_json" | "visibility" | "owner_user_id">;

/**
 * Starts every enabled routine in the workspace that asked for this event. A routine runs on behalf of its owner,
 * so it only gets the source if the owner may see it. One routine failing to start does not stop the others, and
 * each runs once per event id even if the provider sends the event again.
 */
export async function startEventRoutines(
  client: SupabaseClient,
  config: SandboxDeploymentConfig,
  input: StartEventRoutinesInput,
  deps: { dispatch?: typeof dispatchAgentRoutine; now?: () => Date } = {},
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
  const source = sourceData as EventSource | null;
  if (!source?.content_markdown) return 0;

  const title = typeof source.metadata_json?.title === "string" ? source.metadata_json.title : "Untitled meeting";
  const dispatch = deps.dispatch ?? dispatchAgentRoutine;
  const occurrenceAt = (deps.now?.() ?? new Date()).toISOString();
  let started = 0;

  for (const task of matching) {
    // The run is on behalf of the routine's owner, so it may only read what the owner may read.
    const ownerMaySee = source.visibility === "shared" || (!!task.created_by_user_id && source.owner_user_id === task.created_by_user_id);
    if (!ownerMaySee) continue;
    const event: RoutineEventPayload = {
      name: input.name,
      eventId: input.eventId,
      description: "a Fireflies meeting was summarized",
      title,
      text: source.content_markdown.slice(0, MAX_EVENT_TEXT_CHARS),
    };
    try {
      await dispatch({ task, occurrenceAt, config, client, event });
      started += 1;
    } catch (cause) {
      await recordError({
        client,
        workspaceId: input.workspaceId,
        scheduledTaskId: task.id,
        operation: "scheduling",
        message: "A routine could not be started by an event",
        code: "event_routine_start_failed",
        error: cause,
        detail: { event: input.name, event_id: input.eventId },
      });
    }
  }
  return started;
}
