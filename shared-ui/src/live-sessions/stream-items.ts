import type { LiveSessionEvent } from "./types";

export type StreamItem =
  | { type: "user"; seq: number; text: string; agentId: string | null }
  | { type: "assistant"; seq: number; text: string; agentId: string | null }
  | { type: "thinking"; seq: number; text: string; agentId: string | null }
  | { type: "note"; seq: number; text: string }
  | {
      type: "tool";
      seq: number;
      name: string;
      summary: string;
      input: unknown;
      /** Null until the result arrives. */
      result: { text: string; isError: boolean; truncated: boolean } | null;
      agentId: string | null;
    };

const SUMMARY_MAX_CHARS = 100;
const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "description", "prompt"];

function oneLine(value: string): string {
  const line = value.split("\n").find((l) => l.trim())?.trim() ?? "";
  return line.length > SUMMARY_MAX_CHARS ? `${line.slice(0, SUMMARY_MAX_CHARS)}…` : line;
}

/** A short label for what a tool call is acting on. */
export function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return typeof input === "string" ? oneLine(input) : "";
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    if (typeof record[key] === "string" && record[key]) return oneLine(record[key] as string);
  }
  const first = Object.values(record).find((v) => typeof v === "string" && v);
  return typeof first === "string" ? oneLine(first) : "";
}

/** Turns the event log into display items. A tool result joins its tool call by id. */
export function buildStreamItems(events: LiveSessionEvent[]): StreamItem[] {
  const items: StreamItem[] = [];
  const toolsById = new Map<string, Extract<StreamItem, { type: "tool" }>>();

  for (const event of events) {
    const { payload } = event;
    const agentId = payload.agent_id ?? null;

    switch (event.kind) {
      case "user_message":
        items.push({ type: "user", seq: event.seq, text: payload.text ?? "", agentId });
        break;
      case "assistant_text":
        items.push({ type: "assistant", seq: event.seq, text: payload.text ?? "", agentId });
        break;
      case "thinking":
        items.push({ type: "thinking", seq: event.seq, text: payload.text ?? "", agentId });
        break;
      case "session_note":
        items.push({ type: "note", seq: event.seq, text: payload.text ?? "" });
        break;
      case "tool_use": {
        const tool: Extract<StreamItem, { type: "tool" }> = {
          type: "tool",
          seq: event.seq,
          name: payload.name ?? "Tool",
          summary: toolSummary(payload.input),
          input: payload.input,
          result: null,
          agentId,
        };
        items.push(tool);
        if (payload.tool_use_id) toolsById.set(payload.tool_use_id, tool);
        break;
      }
      case "tool_result": {
        const tool = payload.tool_use_id ? toolsById.get(payload.tool_use_id) : undefined;
        if (tool) tool.result = { text: payload.content ?? "", isError: payload.is_error === true, truncated: payload.truncated === true };
        break;
      }
    }
  }
  return items;
}
