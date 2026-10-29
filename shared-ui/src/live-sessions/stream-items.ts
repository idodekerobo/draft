import { splitAuthor } from "draft-core/live-sessions";
import type { ComposerInput, LiveSessionEvent } from "./types";

export type StreamItem =
  | { type: "user"; seq: number; at: string; text: string; agentId: string | null; /** Set when a teammate sent it through Draft. */ author: string | null }
  | { type: "assistant"; seq: number; at: string; text: string; agentId: string | null }
  | { type: "thinking"; seq: number; text: string; agentId: string | null }
  | { type: "note"; seq: number; text: string; interruptedBy?: { id: string; name: string } }
  | { type: "pending"; key: string; input: ComposerInput; author: string; ownerName: string; hostOffline: boolean }
  | {
      type: "approval";
      seq: number;
      requestId: string;
      tool: string;
      summary: string;
      input: unknown;
      /** Null while the request waits for an answer. */
      resolved: { reason: string; decision: "allow" | "deny" | null; byName: string | null; at: string } | null;
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
  const approvalsById = new Map<string, Extract<StreamItem, { type: "approval" }>>();

  for (const event of events) {
    const { payload } = event;
    const agentId = payload.agent_id ?? null;

    switch (event.kind) {
      case "user_message":
        items.push({ type: "user", seq: event.seq, at: event.created_at, ...splitAuthor(payload.text ?? ""), agentId });
        break;
      case "assistant_text":
        items.push({ type: "assistant", seq: event.seq, at: event.created_at, text: payload.text ?? "", agentId });
        break;
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
          tool: payload.name ?? "Tool",
          summary: toolSummary(payload.input),
          input: payload.input,
          resolved: null,
        };
        items.push(approval);
        approvalsById.set(payload.requestId, approval);
        break;
      }
      case "permission_resolved": {
        const approval = payload.requestId ? approvalsById.get(payload.requestId) : undefined;
        if (approval) approval.resolved = { reason: payload.reason ?? "decided", decision: payload.decision ?? null, byName: payload.by_name ?? null, at: event.created_at };
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
  return items;
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
      return `${resolved.decision === "deny" ? "Denied" : "Allowed"} by ${resolved.byName ?? "a teammate"}, ${timeOf(resolved.at)}`;
    case "answered_locally":
      return `Answered ${where}, ${timeOf(resolved.at)}`;
    case "expired":
      return `Expired, ${timeOf(resolved.at)}`;
    default:
      return `Moved to the terminal, ${timeOf(resolved.at)}`;
  }
}
