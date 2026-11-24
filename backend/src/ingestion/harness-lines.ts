import { requireAdapter, type AdapterId } from "draft-core/harnesses";
import { codexExecEventsFor } from "draft-core/harnesses/codex/parse-exec-line";
import { codexEventsFor } from "draft-core/harnesses/codex/parse-live-line";
import { eventsFor as claudeEventsFor, type IncomingLine } from "draft-core/harnesses/claude/live-lines";
import type { ParsedLiveEvent } from "draft-core/harnesses/claude/parse-live-line";

type LineMapper = (line: IncomingLine) => ParsedLiveEvent[];

const MAPPERS: Record<AdapterId, LineMapper> = {
  "claude-terminal": claudeEventsFor,
  "claude-print": claudeEventsFor,
  "codex-app-server": codexEventsFor,
  "codex-exec": codexExecEventsFor,
};

/** Turns one forwarded line into session events with the parser of the adapter that wrote it. Throws for an unknown adapter. */
export function eventsForAdapter(adapterId: string, line: IncomingLine): ParsedLiveEvent[] {
  return MAPPERS[requireAdapter(adapterId).id as AdapterId](line);
}
