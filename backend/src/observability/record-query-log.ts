import type { SupabaseClient } from "@supabase/supabase-js";

export type AgentQueryLogCommand = "sessions.list" | "sessions.read" | "sessions.search";

export interface RecordAgentQueryLogInput {
  workspaceId: string;
  userId: string | null;
  command: AgentQueryLogCommand;
  argsJson: Record<string, unknown>;
  resultBytes: number;
}

/** Best-effort: never blocks or fails the request it's called from. */
export async function recordAgentQueryLog(client: SupabaseClient, input: RecordAgentQueryLogInput): Promise<void> {
  try {
    const { error } = await client.from("agent_query_log").insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      command: input.command,
      args_json: input.argsJson,
      result_bytes: input.resultBytes,
    });
    if (error) console.error("recordAgentQueryLog: insert failed", error);
  } catch (err) {
    console.error("recordAgentQueryLog: insert threw", err);
  }
}
