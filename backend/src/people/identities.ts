import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersonIdentityProvider } from "../types/tables";
import { addIdentity } from "./match";

export type AddPersonIdentityResult = { ok: true; outcome: "created" | "unchanged" } | { ok: false; code: "person_not_found" | "identity_taken" };

/**
 * Adds an identity to a person as `inferred`. An identity that belongs to someone else is refused. One the person
 * already has, at any trust level, is left as it is: this never lowers a confirmed or from_connection identity.
 */
export async function addPersonIdentity(
  client: SupabaseClient,
  workspaceId: string,
  input: { personId: string; provider: PersonIdentityProvider; externalId: string; handle?: string | null; evidence: { sourceItemId?: string; quote?: string } },
): Promise<AddPersonIdentityResult> {
  const { data, error } = await client.from("people").select("id").eq("id", input.personId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  if (!data) return { ok: false, code: "person_not_found" };

  const outcome = await addIdentity(client, workspaceId, input.personId, {
    provider: input.provider,
    externalId: input.provider === "email" ? input.externalId.trim().toLowerCase() : input.externalId,
    handle: input.handle ?? null,
    status: "inferred",
    evidence: input.evidence,
  });
  if (outcome === "taken") return { ok: false, code: "identity_taken" };
  return { ok: true, outcome: outcome === "created" ? "created" : "unchanged" };
}
