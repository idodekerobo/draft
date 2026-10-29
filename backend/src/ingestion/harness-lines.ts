import { codexEventsFor } from "./codex/parse-live-line";
import { eventsFor as claudeEventsFor, type IncomingLine } from "./claude-code/live-lines";
import type { ParsedLiveEvent } from "./claude-code/parse-live-line";

const MAPPERS: Record<string, (line: IncomingLine) => ParsedLiveEvent[]> = {
  claude: claudeEventsFor,
  codex: codexEventsFor,
};

/** Turns one forwarded line into session events with the parser of the harness that wrote it. */
export function eventsForHarness(harness: string, line: IncomingLine): ParsedLiveEvent[] {
  return (MAPPERS[harness] ?? claudeEventsFor)(line);
}
