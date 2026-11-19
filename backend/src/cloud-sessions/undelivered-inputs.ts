import type { SupabaseClient } from "@supabase/supabase-js";

export interface CloudSessionRef {
  workspaceId: string;
  sessionId: string;
}

/** Queued, or claimed by the host and still being pasted. The host counts both as pending, of every kind. */
const UNDELIVERED_STATES = ["queued", "delivering"];

/** True when an input of the session is not yet taken by its host. Throws when the read fails. */
export async function hasUndeliveredInputs(client: SupabaseClient, { workspaceId, sessionId }: CloudSessionRef): Promise<boolean> {
  const { data, error } = await client
    .from("session_inputs")
    .select("id")
    .eq("session_id", sessionId)
    .eq("workspace_id", workspaceId)
    .in("state", UNDELIVERED_STATES)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Wakes the session when an input is still undelivered. Returns true when it did. An input sent while the session
 * was awake got no wake from its own send, so a sleep checks again after the session is asleep.
 */
export async function wakeIfUndelivered(
  client: SupabaseClient,
  session: CloudSessionRef,
  wake: (session: CloudSessionRef) => Promise<unknown>,
): Promise<boolean> {
  if (!(await hasUndeliveredInputs(client, session))) return false;
  await wake(session);
  return true;
}
