import type { HarnessId } from "draft-core/harnesses";
import { eventsFor as claudeEventsFor, type IncomingLine } from "./claude-code/live-lines";
import type { ParsedLiveEvent } from "./claude-code/parse-live-line";

const MAPPERS: Record<HarnessId, (line: IncomingLine) => ParsedLiveEvent[]> = {
  claude: claudeEventsFor,
};

/** Turns one forwarded line into session events with the parser of the harness that wrote it. */
export function eventsForHarness(harness: string, line: IncomingLine): ParsedLiveEvent[] {
  return (MAPPERS[harness as HarnessId] ?? claudeEventsFor)(line);
}
