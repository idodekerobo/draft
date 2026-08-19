import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { upsertSourceConnection, upsertSourceItem } from "../ingestion/upsert-source-item";
import type { AgentSessionRow } from "../types/tables";
import type { SessionSummaryPayload } from "./types";

// The FK anchor claude session summaries need to exist at all -- not the
// workspace-facing toggle from Decision 9 (see step 10).
const CLAUDE_SESSION_CONNECTION_KEY = "agent-sessions";
const MAX_SUMMARY_ATTEMPTS = 3;

export type MaterializeSummaryResult =
  | { ok: true; payload: SessionSummaryPayload }
  | { ok: false; error: unknown };

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function renderSummaryContentMarkdown(payload: SessionSummaryPayload): string {
  const decisions =
    payload.keyDecisions.length > 0
      ? payload.keyDecisions.map((decision) => `- ${decision}`).join("\n")
      : "(none)";
  return `# ${payload.project}

**Who:** ${payload.who}

**Outcome:** ${payload.outcome}

**Key decisions:**
${decisions}
`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// The `WHERE summary_status = 'leased'` guard on every update protects
// against a late/duplicate callback stomping a session a second worker
// already reclaimed after lease expiry.
export async function materializeSessionSummary(
  session: AgentSessionRow,
  result: MaterializeSummaryResult,
  client: SupabaseClient,
): Promise<void> {
  if (result.ok) {
    const connection = await upsertSourceConnection(client, {
      workspace_id: session.workspace_id,
      provider: "claude_session",
      connection_key: CLAUDE_SESSION_CONNECTION_KEY,
    });

    const contentMarkdown = renderSummaryContentMarkdown(result.payload);
    const contentHash = sha256(contentMarkdown);

    await upsertSourceItem(client, {
      workspace_id: session.workspace_id,
      source_connection_id: connection.id,
      item_type: "coding_session",
      external_id: session.external_session_id,
      // Claude sessions have no provider revision id, so the content hash
      // doubles as the revision marker -- mirrors ingestFirefliesMeeting's
      // pattern for providers that give none.
      external_version: contentHash,
      occurred_at: session.ended_at ?? session.started_at,
      content_markdown: contentMarkdown,
      content_hash: contentHash,
      metadata_json: {
        agent_session_id: session.id,
        provider: session.provider,
        contributor_id: session.contributor_id,
        user_id: session.user_id,
        verified: session.user_id !== null,
        summary: result.payload,
      },
    });

    const { error } = await client
      .from("agent_sessions")
      .update({ summary_status: "ok", summary_last_error: null })
      .eq("id", session.id)
      .eq("summary_status", "leased");
    if (error) throw error;
    return;
  }

  const nextStatus = session.summary_attempts >= MAX_SUMMARY_ATTEMPTS ? "skipped" : "failed";
  const { error } = await client
    .from("agent_sessions")
    .update({
      summary_status: nextStatus,
      summary_last_error: errorMessage(result.error).slice(0, 2_000),
    })
    .eq("id", session.id)
    .eq("summary_status", "leased");
  if (error) throw error;
}
