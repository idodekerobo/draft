import type { SupabaseClient } from "@supabase/supabase-js";
import type { VolumeRef } from "../metaharness/sandbox/providers";

/** The sandbox volume ref a session row holds, or null when it is missing or incomplete. */
export function parseVolumeRef(value: unknown): VolumeRef | null {
  if (typeof value !== "object" || value === null) return null;
  const { provider, id, region } = value as Record<string, unknown>;
  return isNonEmptyString(provider) && isNonEmptyString(id) && isNonEmptyString(region) ? { provider, id, region } : null;
}

/** The machine of the newest run of a session that recorded one. Null when no run did. Throws when the read fails. */
export async function latestMachineId(client: SupabaseClient, sessionId: string): Promise<string | null> {
  const { data, error } = await client
    .from("agent_runs")
    .select("sandbox_machine_id")
    .eq("session_id", sessionId)
    .not("sandbox_machine_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as { sandbox_machine_id: string } | null)?.sandbox_machine_id ?? null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
