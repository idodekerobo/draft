import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersonIdentityRow } from "../types/tables";

const TRUSTED = ["confirmed", "from_connection"];

/**
 * The ids to look for in sources when asking about one person: their email, Slack, Linear and other identity ids.
 * Only identities a connection or the person's own account proved are used, so an agent's guess cannot steer a search.
 * `person` is a person id, or "me" for the user making the call.
 */
export async function personSearchTerms(
  client: SupabaseClient,
  workspaceId: string,
  callerUserId: string,
  person: string,
): Promise<{ ok: true; terms: string[] } | { ok: false }> {
  let query = client.from("people").select("id").eq("workspace_id", workspaceId);
  query = person === "me" ? query.eq("user_id", callerUserId) : query.eq("id", person);
  const { data: found, error } = await query.maybeSingle();
  if (error) throw error;
  if (!found) return { ok: false };

  const { data, error: identitiesError } = await client
    .from("person_identities")
    .select("external_id, status")
    .eq("workspace_id", workspaceId)
    .eq("person_id", (found as { id: string }).id);
  if (identitiesError) throw identitiesError;
  const terms = ((data ?? []) as Array<Pick<PersonIdentityRow, "external_id" | "status">>)
    .filter((identity) => TRUSTED.includes(identity.status))
    .map((identity) => identity.external_id);
  return { ok: true, terms: [...new Set(terms)] };
}
