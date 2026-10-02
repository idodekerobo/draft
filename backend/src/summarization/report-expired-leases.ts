import type { SupabaseClient } from "@supabase/supabase-js";
import { recordError } from "../errors/record-error";

const MAX_ATTEMPTS = 3;
const MAX_LOGGED_SESSION_IDS = 25;

// A lease that expires while still 'leased' means a launched run never
// reported back (crashed sandbox, wrong image, lost callback). Call this before
// claiming: the claim re-leases those rows and the signal is gone.
export async function reportExpiredSummaryLeases(
  workspaceId: string,
  client: SupabaseClient,
): Promise<number> {
  try {
    const { data, error } = await client
      .from("agent_sessions")
      .select("id, summary_attempts")
      .eq("workspace_id", workspaceId)
      .eq("summary_status", "leased")
      .lt("summary_lease_until", new Date().toISOString());
    if (error) throw error;

    const expired = (data ?? []) as Array<{ id: string; summary_attempts: number }>;
    if (expired.length === 0) return 0;

    await recordError({
      client,
      workspaceId,
      operation: "execution",
      message: "Summarization run did not report back before its lease expired",
      code: "summarization_lease_expired",
      detail: {
        session_count: expired.length,
        session_ids: expired.slice(0, MAX_LOGGED_SESSION_IDS).map((session) => session.id),
        max_attempts: Math.max(...expired.map((session) => session.summary_attempts)),
        at_cap_count: expired.filter((session) => session.summary_attempts >= MAX_ATTEMPTS).length,
      },
    });
    return expired.length;
  } catch (error) {
    // Diagnostics must never block the batch that follows.
    console.error("reportExpiredSummaryLeases failed", error);
    return 0;
  }
}
