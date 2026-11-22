import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersonIdentityProvider } from "../types/tables";
import { addIdentity, findPersonByIdentity, normalizeEmail } from "./match";

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

export type RemovePersonIdentityResult =
  | { ok: true; outcome: "removed" }
  | { ok: false; code: "person_not_found" | "identity_not_found" | "identity_trusted" };

export type ReplacePersonIdentityResult =
  | { ok: true; outcome: "replaced" | "unchanged" }
  | { ok: false; code: "person_not_found" | "identity_not_found" | "identity_trusted" | "identity_taken" };

const normalizeId = (provider: PersonIdentityProvider, externalId: string) => (provider === "email" ? normalizeEmail(externalId) : externalId);

async function personExists(client: SupabaseClient, workspaceId: string, personId: string): Promise<boolean> {
  const { data, error } = await client.from("people").select("id").eq("id", personId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  return !!data;
}

/**
 * The identity row when this person has it and it is only a guess. A trusted identity comes from a workspace member or
 * a connection, and Draft keeps it in step with that source, so it is not removed or replaced here. An id that belongs to
 * someone else reads as not found, so the answer does not say who owns it.
 */
async function findGuess(client: SupabaseClient, workspaceId: string, personId: string, provider: PersonIdentityProvider, externalId: string) {
  const found = await findPersonByIdentity(client, workspaceId, provider, externalId);
  if (!found || found.personId !== personId) return { ok: false as const, code: "identity_not_found" as const };
  if (found.identity.status !== "inferred") return { ok: false as const, code: "identity_trusted" as const };
  return { ok: true as const, id: found.identity.id };
}

/** Deletes the row only while it is still a guess, so a sync that trusted it a moment ago is not undone. */
async function deleteGuess(client: SupabaseClient, workspaceId: string, identityId: string): Promise<boolean> {
  const { data, error } = await client.from("person_identities").delete().eq("id", identityId).eq("workspace_id", workspaceId).eq("status", "inferred").select("id");
  if (error) throw error;
  return ((data as unknown[] | null)?.length ?? 0) > 0;
}

/** Removes a guessed identity from a person. */
export async function removePersonIdentity(
  client: SupabaseClient,
  workspaceId: string,
  input: { personId: string; provider: PersonIdentityProvider; externalId: string },
): Promise<RemovePersonIdentityResult> {
  if (!(await personExists(client, workspaceId, input.personId))) return { ok: false, code: "person_not_found" };
  const guess = await findGuess(client, workspaceId, input.personId, input.provider, normalizeId(input.provider, input.externalId));
  if (!guess.ok) return guess;
  return (await deleteGuess(client, workspaceId, guess.id)) ? { ok: true, outcome: "removed" } : { ok: false, code: "identity_trusted" };
}

/**
 * Swaps a guessed identity for a corrected one in one call. The new id is added first, so an id that belongs to someone
 * else leaves the old one in place. The corrected id is a guess too.
 */
export async function replacePersonIdentity(
  client: SupabaseClient,
  workspaceId: string,
  input: { personId: string; provider: PersonIdentityProvider; replaces: string; externalId: string; handle?: string | null; evidence: { sourceItemId?: string; quote?: string } },
): Promise<ReplacePersonIdentityResult> {
  if (!(await personExists(client, workspaceId, input.personId))) return { ok: false, code: "person_not_found" };
  const oldId = normalizeId(input.provider, input.replaces);
  const newId = normalizeId(input.provider, input.externalId);
  const guess = await findGuess(client, workspaceId, input.personId, input.provider, oldId);
  if (!guess.ok) return guess;

  const added = await addIdentity(client, workspaceId, input.personId, { provider: input.provider, externalId: newId, handle: input.handle ?? null, status: "inferred", evidence: input.evidence });
  if (added === "taken") return { ok: false, code: "identity_taken" };
  if (oldId === newId) return { ok: true, outcome: "unchanged" };
  return (await deleteGuess(client, workspaceId, guess.id)) ? { ok: true, outcome: "replaced" } : { ok: false, code: "identity_trusted" };
}
