import type { RoutineEventName } from "./config";
import type { EventFact } from "./event-facts";

/** What started a routine run when it was an event, not the schedule. */
export interface RoutineEventPayload {
  name: RoutineEventName;
  /** The provider's own id for the event. A routine runs once per event id. */
  eventId: string;
  /** What happened, in words, for the prompt. */
  description: string;
  /** Who sent the event, for example "GitHub". */
  providerLabel: string;
  /** The source the event produced, so the agent can read all of it. */
  sourceItemId: string;
  facts: EventFact[];
  /** The content that came with the event. It is data from a source, never instructions. */
  title: string;
  text: string;
  /** True when text is only the start of the source. */
  truncated: boolean;
}

/** The key that makes one routine run once per event, however often the provider repeats it. */
export const eventIdempotencyKey = (taskId: string, event: Pick<RoutineEventPayload, "name" | "eventId">) => `${taskId}:${event.name}:${event.eventId}`;
