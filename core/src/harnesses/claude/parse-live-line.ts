import { stripPasteWrapper, type SessionEventKind } from "../../live-sessions";

export interface LiveLineInput {
  stream: string;
  position: number;
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
  origin?: LineOrigin | null;
  message?: { role?: string; content?: string | ContentBlock[] };
  attachment?: { type?: string; prompt?: unknown; origin?: LineOrigin | null };
  toolUseResult?: { agentId?: string; isAsync?: boolean; resolvedModel?: string; status?: string; success?: boolean; resumedAgentId?: string };
}

/** `human` marks a line a person typed. `peer` marks a message from another agent. */
interface LineOrigin {
  kind?: string;
  from?: string;
  name?: string;
  body?: string;
  handback?: boolean;
  handbackReportText?: string;
}

const TEXT_MAX_CHARS = 100_000;
const TOOL_FIELD_MAX_CHARS = 20_000;

// User lines Claude Code writes for its own bookkeeping, not typed by a person.
const HARNESS_WRAPPER = /^<(task-notification|command-name|command-message|system-reminder)>/;
// Claude Code writes this as a user line when someone rejects or interrupts a tool call.
const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]]*\]$/;
const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>\s*$/;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// A message from another agent is wrapped in one of these tags. A team member's message is a
// `teammate-message`. A sub-agent's final report is an `agent-message`. Older versions carry no origin.
const AGENT_LINE = /^(?:Another Claude session sent a message:\s*)?<(?:teammate|agent)-message[\s>]/;
const AGENT_BLOCK = /<(teammate|agent)-message\s+([^>]*)>([\s\S]*?)<\/\1-message>/g;
const ATTRIBUTE = /([\w-]+)="([^"]*)"/g;
const HANDBACK_MARKER = "[Subagent hand-back]";
const HANDBACK_REPORT_START = "The report follows:\n";

const SUBAGENT_FILE = /^subagents\/agent-(.+)\.jsonl$/;

function attributesOf(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, key, value] of raw.matchAll(ATTRIBUTE)) out[key!] = value!;
  return out;
}

/**
 * Reads the messages another agent sent, one per wrapper block. An idle notice carries JSON, whose
 * `result` is what the agent reports. Any other body is shown as written.
 */
function parseAgentMessages(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const [, , rawAttributes, rawBody] of text.matchAll(AGENT_BLOCK)) {
    const attributes = attributesOf(rawAttributes!);
    const from = attributes.teammate_id ?? attributes.from;
    if (!from) continue;
    let type: "idle" | "message" | "handback" = "message";
    let body = rawBody!.trim();
    if (body.startsWith(HANDBACK_MARKER)) {
      type = "handback";
      body = unindentReport(body);
    }
    try {
      const json = JSON.parse(body) as { type?: unknown; result?: unknown; idleReason?: unknown };
      if (json && json.type === "idle_notification") {
        type = "idle";
        body = typeof json.result === "string" ? json.result.trim() : "";
      }
    } catch {
      // Plain text body.
    }
    out.push({
      from,
      type,
      ...(attributes.color ? { color: attributes.color } : {}),
      ...(attributes.summary ? { summary: attributes.summary } : {}),
      text: clip(body, TEXT_MAX_CHARS).text,
    });
  }
  return out;
}

/** The harness frames a hand-back and indents each line of the report. Returns the report alone. */
function unindentReport(body: string): string {
  const start = body.indexOf(HANDBACK_REPORT_START);
  const report = start === -1 ? body : body.slice(start + HANDBACK_REPORT_START.length);
  return report.replace(/^ {2}/gm, "").trim();
}

/**
 * The agent messages a line carries, or none. A structured `peer` origin is read first. Without one,
 * the wrapper tag is read. A line a person typed never counts.
 */
function agentMessagesOf(text: string, origin: LineOrigin | null | undefined): Array<Record<string, unknown>> {
  if (origin?.kind === "human") return [];
  if (origin?.kind === "peer") {
    const from = origin.name || origin.from;
    const body = origin.handback ? origin.handbackReportText : origin.body;
    if (from && typeof body === "string") {
      return [{ from, type: origin.handback ? "handback" : "message", text: clip(body.trim(), TEXT_MAX_CHARS).text }];
    }
  }
  return AGENT_LINE.test(text) ? parseAgentMessages(text) : [];
}

function pushAgentNotes(
  out: Array<Pick<ParsedLiveEvent, "kind" | "payload">>,
  common: Record<string, unknown>,
  agentMessages: Array<Record<string, unknown>>,
): void {
  // `text` is a plain line for clients that do not know the agent message.
  for (const agent_message of agentMessages) {
    out.push({ kind: "session_note", payload: { ...common, text: `Message from ${agent_message.from}`, agent_message } });
  }
}

/** The agent id for a sub-agent transcript file, or null for the root file. */
export function agentIdFromFile(stream: string): string | null {
  return SUBAGENT_FILE.exec(stream)?.[1] ?? null;
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
export function parseLiveLine(line: LiveLineInput, agentId: string | null = agentIdFromFile(line.stream)): ParsedLiveEvent[] {
  let parsed: LiveJsonlLine;
  try {
    parsed = JSON.parse(line.raw);
  } catch {
    return [];
  }
  if (!parsed || parsed.isCompactSummary) return [];
  const origin = parsed.origin ?? parsed.attachment?.origin;
  const content = parsed.message?.content;
  const body = parsed.attachment?.prompt ?? (typeof content === "string" ? content : textOf(content));
  const notification = origin?.kind === "task-notification" && typeof body === "string"
    ? /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(completed|failed|stopped)<\/status>/.exec(body) : null;
  if (parsed.isMeta && origin?.kind !== "peer" && !notification) return [];
  if (parsed.isSidechain && agentId === null) return [];

  const base = typeof parsed.uuid === "string" && parsed.uuid ? parsed.uuid : `${line.stream}:${line.position}`;
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;
  const common = { timestamp, ...(agentId ? { agent_id: agentId } : {}) };
  const out: Array<Pick<ParsedLiveEvent, "kind" | "payload">> = [];

  if (notification) {
    return [{ sourceId: base, kind: "session_note", payload: { ...common, text: "Agent " + notification[2], agent_lifecycle: { id: notification[1], state: "idle", isError: notification[2] === "failed" } } }];
  }
  if (origin?.kind === "peer") {
    pushAgentNotes(out, common, agentMessagesOf(typeof body === "string" ? body : "", origin));
    if (origin.handback && origin.from && out[0]) out[0].payload.agent_lifecycle = { id: origin.from, state: "idle", isError: false };
    return out.map((event, index) => ({ sourceId: index === 0 ? base : `${base}#${index}`, ...event }));
  }

  if (parsed.type === "system") {
    if (parsed.subtype === "compact_boundary") out.push({ kind: "session_note", payload: { ...common, text: "Conversation compacted" } });
  } else if (parsed.type === "attachment" && parsed.attachment?.type === "queued_command" && typeof parsed.attachment.prompt === "string") {
    // A message sent while Claude was mid-turn is logged as this attachment, never as a user line.
    const text = stripPasteWrapper(parsed.attachment.prompt.trim());
    const agentMessages = agentMessagesOf(text, parsed.attachment.origin);
    if (agentMessages.length > 0) pushAgentNotes(out, common, agentMessages);
    else if (text && !HARNESS_WRAPPER.test(text)) out.push({ kind: "user_message", payload: { ...common, ...clip(text, TEXT_MAX_CHARS) } });
  } else if (parsed.type === "user" && parsed.message?.role === "user") {
    const content = parsed.message.content;
    if (typeof content === "string") {
      const text = stripPasteWrapper(content.trim());
      const output = LOCAL_COMMAND_OUTPUT.exec(text);
      const agentMessages = agentMessagesOf(text, parsed.origin);
      if (agentMessages.length > 0) {
        pushAgentNotes(out, common, agentMessages);
      } else if (output) {
        const note = output[2]!.replace(ANSI, "").trim();
        if (note) out.push({ kind: "session_note", payload: { ...common, text: clip(note, TEXT_MAX_CHARS).text } });
      } else if (INTERRUPT_MARKER.test(text)) {
        out.push({ kind: "session_note", payload: { ...common, text } });
      } else if (text && !HARNESS_WRAPPER.test(text)) {
        out.push({ kind: "user_message", payload: { ...common, ...clip(text, TEXT_MAX_CHARS) } });
      }
    } else if (Array.isArray(content)) {
      const text = stripPasteWrapper(textOf(content.filter((b) => b.type === "text" || b.type === "image")).trim());
      if (INTERRUPT_MARKER.test(text)) out.push({ kind: "session_note", payload: { ...common, text } });
      else if (text && !HARNESS_WRAPPER.test(text)) out.push({ kind: "user_message", payload: { ...common, ...clip(text, TEXT_MAX_CHARS) } });
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const result = clip(textOf(block.content), TOOL_FIELD_MAX_CHARS);
        const metadata = parsed.toolUseResult;
        const agentResult = metadata?.agentId ? { id: metadata.agentId, async: metadata.isAsync === true, model: metadata.resolvedModel ?? null } : null;
        const resumed = !block.is_error && metadata?.success === true ? metadata.resumedAgentId : null;
        out.push({
          kind: "tool_result",
          payload: { ...common, tool_use_id: block.tool_use_id ?? null, content: result.text, is_error: block.is_error === true, ...(result.truncated ? { truncated: true } : {}), ...(agentResult ? { agent_result: agentResult } : {}), ...(resumed ? { agent_lifecycle: { id: resumed, state: "working", isError: false } } : {}) },
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
