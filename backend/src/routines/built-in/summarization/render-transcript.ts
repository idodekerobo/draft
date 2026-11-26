import type { SupabaseClient } from "@supabase/supabase-js";
import type { CapturedSessionMessageRow } from "../../../types/tables";

// Conservative cap: keeps a transcript well within what fits in a single
// `claude -p` prompt alongside the shared template and instructions.
export const MAX_TRANSCRIPT_CHARS = 60_000;

function renderTurns(messages: Pick<CapturedSessionMessageRow, "role" | "content">[]): string {
  return messages
    .map((message) => `## ${message.role}\n\n${message.content}`)
    .join("\n\n");
}

// Truncates from the front (oldest turns) so the most recent content --
// closest to the session's outcome -- always survives. Never a silent drop:
// the marker names exactly how many characters were removed.
export function truncateTranscriptFromFront(rendered: string, maxChars = MAX_TRANSCRIPT_CHARS): string {
  if (rendered.length <= maxChars) return rendered;
  const cut = rendered.length - maxChars;
  const marker = `[truncated ${cut} chars]\n\n`;
  return marker + rendered.slice(cut);
}

export async function renderSessionTranscript(
  sessionId: string,
  workspaceId: string,
  client: SupabaseClient,
): Promise<string> {
  const { data, error } = await client
    .from("captured_session_messages")
    .select("role, content")
    .eq("captured_session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .order("seq", { ascending: true });
  if (error) throw error;
  const messages = (data ?? []) as Pick<CapturedSessionMessageRow, "role" | "content">[];
  return truncateTranscriptFromFront(renderTurns(messages));
}
