import type { SupabaseClient } from "@supabase/supabase-js";
import type { SessionRow } from "../types/tables";
import { DEFAULT_HOME_MODEL, HOME_ADAPTER_ID } from "./runtime/spec";

const UNIQUE_VIOLATION = "23505";

async function findHome(client: SupabaseClient, workspaceId: string, ownerUserId: string): Promise<SessionRow | null> {
  const { data, error } = await client
    .from("sessions")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("owner_user_id", ownerUserId)
    .eq("is_home", true)
    .is("ended_at", null)
    .is("deleted_at", null)
    .maybeSingle<SessionRow>();
  if (error) throw error;
  return data;
}

/**
 * The person's one live Home session in a workspace, made on first use. It runs in Draft's backend: execution target
 * `backend`, the `pi-durable-sdk` adapter, and a durable conversation in place of a host. Two calls at once find one row, because
 * a person has at most one open Home (a unique index).
 */
export async function ensureHomeSession(client: SupabaseClient, input: { workspaceId: string; ownerUserId: string }): Promise<SessionRow> {
  const existing = await findHome(client, input.workspaceId, input.ownerUserId);
  if (existing) return existing;

  const id = crypto.randomUUID();
  const { error } = await client.from("sessions").insert({
    id,
    workspace_id: input.workspaceId,
    owner_user_id: input.ownerUserId,
    session_type: "interactive",
    harness: "pi",
    model: DEFAULT_HOME_MODEL,
    host_id: `backend:${id}`,
    host_name: null,
    is_home: true,
    execution_target: "backend",
    adapter_id: HOME_ADAPTER_ID,
    status: "live",
  });
  if (error) {
    if (error.code !== UNIQUE_VIOLATION) throw error;
    const winner = await findHome(client, input.workspaceId, input.ownerUserId);
    if (winner) return winner;
    throw error;
  }
  const created = await findHome(client, input.workspaceId, input.ownerUserId);
  if (!created) throw new Error("The Home session was not saved");
  return created;
}
