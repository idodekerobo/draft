import type { SessionEventKind } from "../../types/tables";

export interface LiveLineInput {
  file: string;
  offset: number;
  raw: string;
}

export interface ParsedLiveEvent {
  sourceId: string;
  kind: SessionEventKind;
  payload: Record<string, unknown>;
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | ContentBlock[];
}

interface LiveJsonlLine {
  type?: string;
  subtype?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  message?: { role?: string; content?: string | ContentBlock[] };
}

const TEXT_MAX_CHARS = 100_000;
const TOOL_FIELD_MAX_CHARS = 20_000;

// User lines Claude Code writes for its own bookkeeping, not typed by a person.
const HARNESS_WRAPPER = /^<(task-notification|command-name|command-message|system-reminder)>/;
const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export const ROOT_FILE = "root.jsonl";
const SUBAGENT_FILE = /^subagents\/agent-(.+)\.jsonl$/;

/** The agent id for a sub-agent transcript file, or null for the root file. */
export function agentIdFromFile(file: string): string | null {
  return SUBAGENT_FILE.exec(file)?.[1] ?? null;
}

function clip(text: string, max: number): { text: string; truncated?: true } {
  return text.length <= max ? { text } : { text: text.slice(0, max), truncated: true };
}

function textOf(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" && block.text ? block.text : block.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

function toolInput(input: unknown): { input: unknown; input_truncated?: true } {
  const json = JSON.stringify(input ?? {});
  if (json.length <= TOOL_FIELD_MAX_CHARS) return { input };
  return { input: json.slice(0, TOOL_FIELD_MAX_CHARS), input_truncated: true };
}

/**
 * Maps one raw Claude Code JSONL line to the session events it shows. Sub-agent
 * transcripts pass their agent id; their lines are all marked as side chains.
 */
export function parseLiveLine(line: LiveLineInput, agentId: string | null = agentIdFromFile(line.file)): ParsedLiveEvent[] {
  let parsed: LiveJsonlLine;
  try {
    parsed = JSON.parse(line.raw);
  } catch {
    return [];
  }
  if (!parsed || parsed.isMeta || parsed.isCompactSummary) return [];
  if (parsed.isSidechain && agentId === null) return [];

  const base = typeof parsed.uuid === "string" && parsed.uuid ? parsed.uuid : `${line.file}:${line.offset}`;
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
  const common = { timestamp, ...(agentId ? { agent_id: agentId } : {}) };
  const out: Array<Pick<ParsedLiveEvent, "kind" | "payload">> = [];

  if (parsed.type === "system") {
    if (parsed.subtype === "compact_boundary") out.push({ kind: "session_note", payload: { ...common, text: "Conversation compacted" } });
  } else if (parsed.type === "user" && parsed.message?.role === "user") {
    const content = parsed.message.content;
    if (typeof content === "string") {
      const text = content.trim();
      const output = LOCAL_COMMAND_OUTPUT.exec(text);
      if (output) {
        const note = output[2]!.replace(ANSI, "").trim();
        if (note) out.push({ kind: "session_note", payload: { ...common, text: clip(note, TEXT_MAX_CHARS).text } });
      } else if (text && !HARNESS_WRAPPER.test(text)) {
        out.push({ kind: "user_message", payload: { ...common, ...clip(text, TEXT_MAX_CHARS) } });
      }
    } else if (Array.isArray(content)) {
      const text = textOf(content.filter((b) => b.type === "text" || b.type === "image")).trim();
      if (text && !HARNESS_WRAPPER.test(text)) out.push({ kind: "user_message", payload: { ...common, ...clip(text, TEXT_MAX_CHARS) } });
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const result = clip(textOf(block.content), TOOL_FIELD_MAX_CHARS);
        out.push({
          kind: "tool_result",
          payload: { ...common, tool_use_id: block.tool_use_id ?? null, content: result.text, is_error: block.is_error === true, ...(result.truncated ? { truncated: true } : {}) },
        });
      }
    }
  } else if (parsed.type === "assistant" && parsed.message?.role === "assistant" && Array.isArray(parsed.message.content)) {
    for (const block of parsed.message.content) {
      if (block.type === "text" && block.text?.trim()) {
        out.push({ kind: "assistant_text", payload: { ...common, ...clip(block.text.trim(), TEXT_MAX_CHARS) } });
      } else if (block.type === "thinking" && block.thinking?.trim()) {
        out.push({ kind: "thinking", payload: { ...common, ...clip(block.thinking.trim(), TEXT_MAX_CHARS) } });
      } else if (block.type === "tool_use") {
        out.push({ kind: "tool_use", payload: { ...common, tool_use_id: block.id ?? null, name: block.name ?? "unknown", ...toolInput(block.input) } });
      }
    }
  }

  return out.map((event, index) => ({ sourceId: index === 0 ? base : `${base}#${index}`, ...event }));
}
