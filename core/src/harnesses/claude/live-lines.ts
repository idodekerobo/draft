import { parseLiveLine, type LiveLineInput, type ParsedLiveEvent } from "./parse-live-line";

export type IncomingLine = LiveLineInput | { stream: string; position: number; oversizeBytes: number };

export function isIncomingLine(value: unknown): value is IncomingLine {
  if (!value || typeof value !== "object") return false;
  const line = value as Record<string, unknown>;
  if (typeof line.stream !== "string" || !Number.isInteger(line.position)) return false;
  return typeof line.raw === "string" || Number.isInteger(line.oversizeBytes);
}

export function eventsFor(line: IncomingLine): ParsedLiveEvent[] {
  if ("raw" in line) return parseLiveLine(line);
  return [
    {
      sourceId: `${line.stream}:${line.position}`,
      kind: "session_note",
      payload: { text: "A very large item was skipped", reason: "too_large", bytes: line.oversizeBytes },
    },
  ];
}
