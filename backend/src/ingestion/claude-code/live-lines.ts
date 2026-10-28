import { parseLiveLine, type LiveLineInput, type ParsedLiveEvent } from "./parse-live-line";

export type IncomingLine = LiveLineInput | { file: string; offset: number; oversizeBytes: number };

export function isIncomingLine(value: unknown): value is IncomingLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  if (typeof line.file !== "string" || !Number.isInteger(line.offset)) return false;
  return typeof line.raw === "string" || Number.isInteger(line.oversizeBytes);
}

export function eventsFor(line: IncomingLine): ParsedLiveEvent[] {
  if ("raw" in line) return parseLiveLine(line);
  return [
    {
      sourceId: `${line.file}:${line.offset}`,
      kind: "session_note",
      payload: { text: "A very large item was skipped", reason: "too_large", bytes: line.oversizeBytes },
    },
  ];
}
