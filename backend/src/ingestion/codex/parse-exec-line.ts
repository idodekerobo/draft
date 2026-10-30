import type { IncomingLine } from "../claude-code/live-lines";
import type { LiveLineInput, ParsedLiveEvent } from "../claude-code/parse-live-line";
import { itemEvents, type CodexItem, type Pending } from "./parse-live-line";

/** One item in the JSONL that `codex exec --json` prints. Same things as an app-server item, in snake_case. */
interface ExecItem {
  type?: string;
  id?: string;
  text?: string;
  command?: string;
  aggregated_output?: string | null;
  exit_code?: number | null;
  status?: string;
  changes?: Array<{ path: string; kind?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown[] } | null;
  error?: { message?: string } | null;
}

interface ExecEvent {
  type?: string;
  item?: ExecItem;
  message?: string;
  error?: { message?: string };
}

function toCodexItem(item: ExecItem): CodexItem | null {
  const { id, status } = item;
  switch (item.type) {
    case "agent_message":
      return { type: "agentMessage", id, text: item.text };
    case "reasoning":
      return { type: "reasoning", id, summary: item.text ? [item.text] : [] };
    case "command_execution":
      return { type: "commandExecution", id, command: item.command, aggregatedOutput: item.aggregated_output, exitCode: item.exit_code, status };
    case "file_change":
      return { type: "fileChange", id, status, changes: (item.changes ?? []).map((change) => ({ path: change.path, kind: { type: change.kind } })) };
    case "mcp_tool_call":
      return { type: "mcpToolCall", id, server: item.server, tool: item.tool, arguments: item.arguments, result: item.result, error: item.error, status };
    default:
      return null;
  }
}

/**
 * Maps one line of `codex exec --json` to the session events it shows. Only finished items and a failed turn
 * count; the start of an item and token usage show nothing.
 */
export function parseCodexExecLine(line: LiveLineInput): ParsedLiveEvent[] {
  let event: ExecEvent;
  try {
    event = JSON.parse(line.raw);
  } catch {
    return [];
  }

  let base: string;
  let events: Pending[] = [];
  if (event?.type === "item.completed" && event.item) {
    const item = toCodexItem(event.item);
    if (!item) return [];
    base = `${line.file}:${item.id ?? line.offset}`;
    events = itemEvents(item);
  } else if (event?.type === "turn.failed" || event?.type === "error") {
    base = `${line.file}:error:${line.offset}`;
    events = [{ kind: "session_note", payload: { text: event.error?.message ?? event.message ?? "The turn failed" } }];
  } else {
    return [];
  }
  return events.map((mapped, index) => ({ sourceId: index === 0 ? base : `${base}#${index}`, ...mapped }));
}

export function codexExecEventsFor(line: IncomingLine): ParsedLiveEvent[] {
  if ("raw" in line) return parseCodexExecLine(line);
  return [
    {
      sourceId: `${line.file}:${line.offset}`,
      kind: "session_note",
      payload: { text: "A very large item was skipped", reason: "too_large", bytes: line.oversizeBytes },
    },
  ];
}
