import type { SupabaseClient } from "@supabase/supabase-js";

/** One page of a run's transcript, as plain lines. `nextCursor` is null on the last page. */
export interface TranscriptPage {
  lines: string[];
  nextCursor: number | null;
}

const MAX_PAGE_CHARS = 24_000;
const MAX_PAGE_EVENTS = 200;
const MAX_TOOL_INPUT_CHARS = 500;
const MAX_TOOL_RESULT_CHARS = 2_000;

type EventRow = { seq: number; kind: string; payload: Record<string, unknown> | null };

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text);
const text = (value: unknown) => (typeof value === "string" ? value : "");

/** One event as one line. Thinking, previews and approval bookkeeping are left out. */
function line(event: EventRow): string | null {
  const payload = event.payload ?? {};
  switch (event.kind) {
    case "user_message":
      return `Prompt: ${clip(text(payload.text), MAX_PAGE_CHARS)}`;
    case "assistant_text":
      return payload.preview ? null : `Agent: ${clip(text(payload.text), MAX_PAGE_CHARS)}`;
    case "tool_use":
      return `Tool ${text(payload.name) || "call"}: ${clip(JSON.stringify(payload.input ?? {}), MAX_TOOL_INPUT_CHARS)}`;
    case "tool_result":
      return `${payload.is_error === true ? "Tool error" : "Tool result"}: ${clip(text(payload.content), MAX_TOOL_RESULT_CHARS)}`;
    case "session_note":
      return `Note: ${text(payload.text)}`;
    default:
      return null;
  }
}

/**
 * Reads a run's transcript a page at a time, so a long run never fills the caller's context. Tool inputs and
 * results are clipped; the full run is in the app's session view.
 */
export async function readRunTranscript(client: SupabaseClient, workspaceId: string, sessionId: string, cursor = 0): Promise<TranscriptPage> {
  const { data, error } = await client
    .from("session_events")
    .select("seq, kind, payload")
    .eq("workspace_id", workspaceId)
    .eq("session_id", sessionId)
    .gt("seq", cursor)
    .order("seq", { ascending: true })
    .limit(MAX_PAGE_EVENTS + 1);
  if (error) throw error;
  const rows = (data ?? []) as EventRow[];

  const lines: string[] = [];
  let size = 0;
  let lastSeq = cursor;
  for (const row of rows.slice(0, MAX_PAGE_EVENTS)) {
    const next = line(row);
    if (next && size + next.length > MAX_PAGE_CHARS && lines.length > 0) return { lines, nextCursor: lastSeq };
    if (next) {
      lines.push(next);
      size += next.length;
    }
    lastSeq = row.seq;
  }
  return { lines, nextCursor: rows.length > MAX_PAGE_EVENTS ? lastSeq : null };
}
