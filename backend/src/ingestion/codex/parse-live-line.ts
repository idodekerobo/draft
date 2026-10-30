import { stripPasteWrapper } from "draft-core/live-sessions";
import type { IncomingLine } from "../claude-code/live-lines";
import type { LiveLineInput, ParsedLiveEvent } from "../claude-code/parse-live-line";

const TEXT_MAX_CHARS = 100_000;
const TOOL_FIELD_MAX_CHARS = 20_000;

interface UserInputPart {
  type: string;
  text?: string;
}

export interface CodexItem {
  type?: string;
  id?: string;
  /** Input parts for a user message, plain strings for reasoning. */
  content?: Array<UserInputPart | string>;
  text?: string;
  summary?: string[];
  command?: string;
  cwd?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  status?: string;
  changes?: Array<{ path: string; kind?: { type?: string } }>;
  server?: string;
  tool?: string;
  namespace?: string | null;
  arguments?: unknown;
  result?: { content?: unknown[] } | null;
  error?: { message?: string } | null;
  success?: boolean | null;
}

interface CodexNotification {
  method?: string;
  params?: { threadId?: string; item?: CodexItem; turn?: { id?: string; status?: string; error?: { message?: string } | null } };
}

export type Pending = Pick<ParsedLiveEvent, "kind" | "payload">;

function clip(text: string, max: number): { text: string; truncated?: true } {
  return text.length <= max ? { text } : { text: text.slice(0, max), truncated: true };
}

function toolInput(input: unknown): { input: unknown; input_truncated?: true } {
  const json = JSON.stringify(input ?? {});
  return json.length <= TOOL_FIELD_MAX_CHARS ? { input } : { input: json.slice(0, TOOL_FIELD_MAX_CHARS), input_truncated: true };
}

function toolResult(toolUseId: string, content: string, isError: boolean): Pending {
  const result = clip(content, TOOL_FIELD_MAX_CHARS);
  return { kind: "tool_result", payload: { tool_use_id: toolUseId, content: result.text, is_error: isError, ...(result.truncated ? { truncated: true } : {}) } };
}

export function itemEvents(item: CodexItem): Pending[] {
  const id = item.id ?? "";
  switch (item.type) {
    case "userMessage": {
      const text = stripPasteWrapper((item.content ?? []).map((part) => (typeof part === "string" || part.type !== "text" ? "" : (part.text ?? ""))).filter(Boolean).join("\n").trim());
      return text ? [{ kind: "user_message", payload: clip(text, TEXT_MAX_CHARS) }] : [];
    }
    case "agentMessage":
      return item.text?.trim() ? [{ kind: "assistant_text", payload: clip(item.text.trim(), TEXT_MAX_CHARS) }] : [];
    case "reasoning": {
      const text = [...(item.summary ?? []), ...(item.content ?? []).filter((part): part is string => typeof part === "string")].join("\n").trim();
      return text ? [{ kind: "thinking", payload: clip(text, TEXT_MAX_CHARS) }] : [];
    }
    case "commandExecution":
      return [
        { kind: "tool_use", payload: { tool_use_id: id, name: "command", ...toolInput({ command: item.command, cwd: item.cwd }) } },
        toolResult(id, item.aggregatedOutput ?? (item.status === "declined" ? "Declined" : ""), item.status === "failed" || item.status === "declined" || (item.exitCode != null && item.exitCode !== 0)),
      ];
    case "fileChange":
      return [
        { kind: "tool_use", payload: { tool_use_id: id, name: "file_change", ...toolInput({ changes: (item.changes ?? []).map((change) => ({ path: change.path, kind: change.kind?.type })) }) } },
        toolResult(id, item.status ?? "", item.status === "failed" || item.status === "declined"),
      ];
    case "mcpToolCall":
    case "dynamicToolCall": {
      const name = item.type === "mcpToolCall" ? `${item.server}.${item.tool}` : [item.namespace, item.tool].filter(Boolean).join(".");
      const content = item.error?.message ?? (item.result ? JSON.stringify(item.result.content ?? []) : "");
      return [
        { kind: "tool_use", payload: { tool_use_id: id, name, ...toolInput(item.arguments) } },
        toolResult(id, content, item.status === "failed" || item.success === false || !!item.error),
      ];
    }
    default:
      return [];
  }
}

/**
 * Maps one line forwarded from a Codex app-server thread to the session events it shows. The host forwards
 * completed items and the end of each turn; token deltas and other notifications never reach the server.
 */
export function parseCodexLine(line: LiveLineInput): ParsedLiveEvent[] {
  let note: CodexNotification;
  try {
    note = JSON.parse(line.raw);
  } catch {
    return [];
  }
  const params = note?.params;
  if (!params) return [];

  let base: string;
  let events: Pending[] = [];
  if (note.method === "item/completed" && params.item) {
    base = `${params.threadId ?? line.file}:${params.item.id ?? line.offset}`;
    events = itemEvents(params.item);
  } else if (note.method === "turn/completed" && params.turn) {
    base = `${params.threadId ?? line.file}:turn:${params.turn.id ?? line.offset}`;
    if (params.turn.status === "failed") events = [{ kind: "session_note", payload: { text: params.turn.error?.message ?? "The turn failed" } }];
    else if (params.turn.status === "interrupted") events = [{ kind: "session_note", payload: { text: "The turn was interrupted" } }];
  } else {
    return [];
  }
  return events.map((event, index) => ({ sourceId: index === 0 ? base : `${base}#${index}`, ...event }));
}

export function codexEventsFor(line: IncomingLine): ParsedLiveEvent[] {
  if ("raw" in line) return parseCodexLine(line);
  return [
    {
      sourceId: `${line.file}:${line.offset}`,
      kind: "session_note",
      payload: { text: "A very large item was skipped", reason: "too_large", bytes: line.oversizeBytes },
    },
  ];
}
