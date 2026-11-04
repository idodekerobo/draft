import { splitAuthor } from "draft-core/live-sessions";
import type { AnswerValue, ApprovalKind, ComposerInput, LiveQuestion, LiveSessionEvent } from "./types";

export type StreamItem =
  | { type: "user"; seq: number; at: string; text: string; agentId: string | null; /** Set when someone sent it through Draft. */ author: string | null; authorUserId: string | null; /** The sender's current name. Wins over `author`, a name saved in the text at send time. */ authorName: string | null }
  | { type: "assistant"; seq: number; at: string; text: string; agentId: string | null }
  | { type: "thinking"; seq: number; text: string; agentId: string | null }
  | { type: "note"; seq: number; text: string; interruptedBy?: { id: string; name: string } }
  | { type: "pending"; key: string; input: ComposerInput; author: string; ownerName: string; hostOffline: boolean }
  | {
      type: "approval";
      seq: number;
      requestId: string;
      /** Requests posted before kinds existed have none and count as plain approvals. */
      kind: ApprovalKind;
      tool: string;
      summary: string;
      input: unknown;
      questions: LiveQuestion[];
      plan: string | null;
      allowSession: boolean;
      /** For a plan: the mode the session is in. */
      permissionMode: string | null;
      /** Null while the request waits for an answer. */
      resolved: {
        reason: string;
        decision: "allow" | "deny" | null;
        byName: string | null;
        at: string;
        answers: Record<string, AnswerValue> | null;
        permissionMode: string | null;
      } | null;
    }
  | {
      type: "tool";
      seq: number;
      name: string;
      summary: string;
      input: unknown;
      /** Null until the result arrives. */
      result: { text: string; isError: boolean; truncated: boolean } | null;
      agentId: string | null;
      /** The sub-agent's own items, for a tool call that started one. */
      children?: StreamItem[];
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

const PREFIX_CHARS = 60;

/** Letters and digits only, so Markdown marks and spacing do not stop two copies of a message from matching. */
const plain = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

function sameMessage(a: string, b: string): boolean {
  if (a === b) return true;
  return a.length >= PREFIX_CHARS && b.length >= PREFIX_CHARS && a.slice(0, PREFIX_CHARS) === b.slice(0, PREFIX_CHARS);
}

const AGENT_TOOLS = new Set(["Agent", "Task"]);
const LAUNCHED_AGENT_ID = /agentId:\s*([A-Za-z0-9_-]+)/;

/**
 * Moves each sub-agent's items under the tool call that started it, found by the agent id in the
 * call's result. A run with no such call gets a block of its own, so nothing sits loose in the stream.
 */
function nestAgentRuns(items: StreamItem[]): StreamItem[] {
  const hosts = new Map<string, Extract<StreamItem, { type: "tool" }>>();
  for (const item of items) {
    if (item.type !== "tool" || item.agentId !== null || !AGENT_TOOLS.has(item.name)) continue;
    const id = item.result ? LAUNCHED_AGENT_ID.exec(item.result.text)?.[1] : undefined;
    if (id && !hosts.has(id)) hosts.set(id, item);
  }
  const launched = new Set(hosts.values());
  const out: StreamItem[] = [];
  for (const item of items) {
    if (!("agentId" in item) || item.agentId === null) {
      out.push(item);
      continue;
    }
    const id = item.agentId;
    let host = hosts.get(id);
    if (!host) {
      host = { type: "tool", seq: item.seq, name: "Sub-agent", summary: "", input: null, result: { text: "", isError: false, truncated: false }, agentId: null, children: [] };
      hosts.set(id, host);
      out.push(host);
    }
    // A launched agent's prompt is already in the call's input.
    if (item.type === "user" && launched.has(host)) continue;
    (host.children ??= []).push(item);
  }
  return out;
}

/** Turns the event log into display items. A tool result joins its tool call by id. */
export function buildStreamItems(events: LiveSessionEvent[]): StreamItem[] {
  const items: StreamItem[] = [];
  const toolsById = new Map<string, Extract<StreamItem, { type: "tool" }>>();
  const approvalsById = new Map<string, Extract<StreamItem, { type: "approval" }>>();
  // Early copies of messages that end in a request. The transcript's own copy arrives after the request ends and is dropped.
  const previews: string[] = [];

  for (const event of events) {
    const { payload } = event;
    const agentId = payload.agent_id ?? null;

    switch (event.kind) {
      case "user_message":
        previews.length = 0;
        items.push({ type: "user", seq: event.seq, at: event.created_at, ...splitAuthor(payload.text ?? ""), authorUserId: event.author_user_id ?? null, authorName: event.author_name ?? null, agentId });
        break;
      case "assistant_text": {
        if (payload.preview) previews.push(plain(payload.text ?? ""));
        else if (previews.length > 0) {
          const key = plain(payload.text ?? "");
          const match = previews.findIndex((p) => sameMessage(p, key));
          if (match >= 0) {
            previews.splice(match, 1);
            break;
          }
        }
        items.push({ type: "assistant", seq: event.seq, at: event.created_at, text: payload.text ?? "", agentId });
        break;
      }
      case "thinking":
        items.push({ type: "thinking", seq: event.seq, text: payload.text ?? "", agentId });
        break;
      case "session_note":
        items.push({ type: "note", seq: event.seq, text: payload.text ?? "", interruptedBy: payload.interrupted_by });
        break;
      case "permission_request": {
        if (!payload.requestId) break;
        const approval: Extract<StreamItem, { type: "approval" }> = {
          type: "approval",
          seq: event.seq,
          requestId: payload.requestId,
          kind: payload.kind ?? "approval",
          tool: payload.name ?? "Tool",
          summary: payload.kind === "question" ? (payload.questions?.[0]?.question ?? "") : toolSummary(payload.input),
          input: payload.input,
          questions: payload.questions ?? [],
          plan: payload.plan ?? null,
          allowSession: payload.allowSession === true,
          permissionMode: payload.permissionMode ?? null,
          resolved: null,
        };
        items.push(approval);
        approvalsById.set(payload.requestId, approval);
        break;
      }
      case "permission_resolved": {
        const approval = payload.requestId ? approvalsById.get(payload.requestId) : undefined;
        if (approval) {
          approval.resolved = {
            reason: payload.reason ?? "decided",
            decision: payload.decision ?? null,
            byName: payload.by_name ?? null,
            at: event.created_at,
            answers: payload.answers ?? null,
            permissionMode: payload.permissionMode ?? null,
          };
        }
        break;
      }
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
  return nestAgentRuns(items);
}

export type OpenApproval = Extract<StreamItem, { type: "approval" }>;

/** Requests that still wait for an answer. */
export function openApprovals(items: StreamItem[]): OpenApproval[] {
  return items.filter((item): item is OpenApproval => item.type === "approval" && item.resolved === null);
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** The one line that replaces a request once it ends. */
export function approvalOutcome(approval: OpenApproval, hostName: string | null): string {
  const resolved = approval.resolved;
  if (!resolved) return "";
  const where = hostName ? `on ${hostName}` : "in the terminal";
  switch (resolved.reason) {
    case "decided":
      if (approval.kind === "question" && resolved.decision === "allow") return `Answered by ${resolved.byName ?? "a teammate"}, ${timeOf(resolved.at)}`;
      if (approval.kind === "plan") {
        const who = resolved.byName ?? "a teammate";
        if (resolved.decision === "deny") return `${who} asked for changes, ${timeOf(resolved.at)}`;
        const mode = resolved.permissionMode === "auto" ? ", auto mode" : resolved.permissionMode === "default" ? ", manual edits" : "";
        return `Approved by ${who}${mode}, ${timeOf(resolved.at)}`;
      }
      return `${resolved.decision === "deny" ? "Denied" : "Allowed"} by ${resolved.byName ?? "a teammate"}, ${timeOf(resolved.at)}`;
    case "answered_locally":
      return `Answered ${where}, ${timeOf(resolved.at)}`;
    case "expired":
      return `Expired, ${timeOf(resolved.at)}`;
    default:
      return `Moved to the terminal, ${timeOf(resolved.at)}`;
  }
}

/** Whether the viewer wrote this human message. Prefers the author's user id, then the name, then session ownership. */
export function isMine(
  item: Extract<StreamItem, { type: "user" | "pending" }>,
  viewer: { id?: string; name: string; isOwner: boolean },
): boolean {
  if (item.type === "pending") return item.input.mine;
  if (item.authorUserId) return item.authorUserId === viewer.id;
  if (item.author) return item.author === viewer.name;
  return viewer.isOwner;
}
