import type { SupabaseClient } from "@supabase/supabase-js";

import type { AgentQueryLogCommand } from "./logged-commands";

export type { AgentQueryLogCommand };

export interface RecordAgentQueryLogInput {
  workspaceId: string;
  userId: string | null;
  sessionId?: string;
  command: AgentQueryLogCommand;
  argsJson: Record<string, unknown>;
  resultBytes: number;
  surface?: "cli" | "mcp";
  status?: "ok" | "conflict" | "refused" | "denied" | "invalid" | "error";
  durationMs?: number;
  errorCode?: string | null;
}

/** Best-effort: never blocks or fails the request it's called from. */
export async function recordAgentQueryLog(client: SupabaseClient, input: RecordAgentQueryLogInput): Promise<void> {
  try {
    const { error } = await client.from("agent_query_log").insert({
      workspace_id: input.workspaceId,
      user_id: input.userId,
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      command: input.command,
      args_json: input.argsJson,
      result_bytes: input.resultBytes,
      surface: input.surface ?? (input.command.startsWith("mcp.") ? "mcp" : "cli"),
      status: input.status ?? null,
      duration_ms: input.durationMs ?? null,
      error_code: input.errorCode ?? null,
    });
    if (error) console.error("recordAgentQueryLog: insert failed", error);
  } catch (err) {
    console.error("recordAgentQueryLog: insert threw", err);
  }
}
