import type { SessionEventKind } from "../../types/tables";

export interface LiveLineInput {
  file: string;
  offset: number;
  raw: string;
}

export interface ParsedLiveEvent {
  sourceId: string;
  kind: SessionEventKind;
  payload: { text: string; timestamp: string | null };
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface LiveJsonlLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: string | ContentBlock[] };
}

// User lines Claude Code writes for its own bookkeeping, not typed by a person.
const HARNESS_WRAPPER = /^<(task-notification|command-name|command-message|local-command-[a-z]+|system-reminder)>/;

function textFromContent(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!.trim())
    .join("\n")
    .trim();
}

/** Maps one raw Claude Code JSONL line to a session event, or null when it has nothing to show. */
export function parseLiveLine(line: LiveLineInput): ParsedLiveEvent | null {
  let parsed: LiveJsonlLine;
  try {
    parsed = JSON.parse(line.raw);
  } catch {
    return null;
  }
  if (!parsed || parsed.isSidechain || parsed.isMeta || parsed.isCompactSummary) return null;

  const role = parsed.message?.role;
  const kind: SessionEventKind | null =
    parsed.type === "user" && role === "user" ? "user_message"
    : parsed.type === "assistant" && role === "assistant" ? "assistant_text"
    : null;
  if (!kind) return null;

  const text = textFromContent(parsed.message?.content);
  if (!text || (kind === "user_message" && HARNESS_WRAPPER.test(text))) return null;

  return {
    sourceId: typeof parsed.uuid === "string" && parsed.uuid ? parsed.uuid : `${line.file}:${line.offset}`,
    kind,
    payload: { text, timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null },
  };
}
