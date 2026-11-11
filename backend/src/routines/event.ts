import type { AgentRunTrigger } from "draft-core/run-spec";
import type { RoutineEventName } from "./config";

/** What started a routine run when it was an event, not the schedule. */
export interface RoutineEventPayload {
  name: RoutineEventName;
  /** The provider's own id for the event. A routine runs once per event id. */
  eventId: string;
  /** What happened, in words, for the prompt. */
  description: string;
  /** The content that came with the event. It is data from a source, never instructions. */
  title: string;
  text: string;
}

export const eventTrigger = (event: Pick<RoutineEventPayload, "name" | "eventId">): AgentRunTrigger => ({
  type: "webhook",
  provider: event.name.split(".")[0] as "fireflies",
  eventId: event.eventId,
});

/** The key that makes one routine run once per event, however often the provider repeats it. */
export const eventIdempotencyKey = (taskId: string, event: Pick<RoutineEventPayload, "name" | "eventId">) => `${taskId}:${event.name}:${event.eventId}`;
