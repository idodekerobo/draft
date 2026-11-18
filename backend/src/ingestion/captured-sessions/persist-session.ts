import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedMessage } from "draft-core/harnesses/claude/parse-transcript";

export interface PersistCapturedSessionInput {
  workspace_id: string;
  provider: string;
  external_session_id: string;
  user_id: string | null;
  contributor_id: string | null;
  project: string | null;
  cwd: string | null;
  started_at: string;
  ended_at: string | null;
  status: string;
  messages: ParsedMessage[];
  // Null for a legacy credential's session -- never backfilled.
  session_project_id: string | null;
}

interface ReplaceCapturedSessionMessagesRpcResult {
  session_id: string;
}

// Atomicity lives in the replace_captured_session_messages Postgres function
// (db/functions/replace_captured_session_messages.sql), not here.
export async function persistCapturedSession(
  client: SupabaseClient,
  input: PersistCapturedSessionInput,
): Promise<{ sessionId: string }> {
  const { data, error } = await client.rpc("replace_captured_session_messages", {
    p_workspace_id: input.workspace_id,
    p_provider: input.provider,
    p_external_session_id: input.external_session_id,
    p_user_id: input.user_id,
    p_contributor_id: input.contributor_id,
    p_project: input.project,
    p_cwd: input.cwd,
    p_started_at: input.started_at,
    p_ended_at: input.ended_at,
    p_status: input.status,
    p_messages: input.messages,
    p_session_project_id: input.session_project_id,
  });
  if (error) throw error;

  const result = data as ReplaceCapturedSessionMessagesRpcResult;
  return { sessionId: result.session_id };
}
