import type { SupabaseClient } from "@supabase/supabase-js";
import type { PersonIdentityProvider, PersonIdentityRow, PersonIdentityStatus } from "../types/tables";

const UNIQUE_VIOLATION = "23505";

/** How far an identity can be trusted. A sync may raise an identity up this ladder and never lowers it. */
const TRUST: Record<PersonIdentityStatus, number> = { inferred: 0, from_connection: 1, confirmed: 2 };

export interface IdentityInput {
  provider: PersonIdentityProvider;
  externalId: string;
  handle?: string | null;
  status: PersonIdentityStatus;
  sourceConnectionId?: string | null;
  evidence?: Record<string, unknown>;
}

export type IdentityOutcome = "created" | "raised" | "unchanged" | "taken";

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/** The person who owns this identity in the workspace, or null. */
export async function findPersonByIdentity(
  client: SupabaseClient,
  workspaceId: string,
  provider: PersonIdentityProvider,
  externalId: string,
): Promise<{ personId: string; identity: PersonIdentityRow } | null> {
  const { data, error } = await client
    .from("person_identities")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .eq("external_id", externalId)
    .maybeSingle();
  if (error) throw error;
  const identity = data as PersonIdentityRow | null;
  return identity ? { personId: identity.person_id, identity } : null;
}

/**
 * Adds an identity to a person. An identity that another person owns is left alone ("taken"). One this person
 * already has is only raised to a more trusted status, and its handle is refreshed. It is never lowered.
 */
export async function addIdentity(client: SupabaseClient, workspaceId: string, personId: string, input: IdentityInput): Promise<IdentityOutcome> {
  const existing = await findPersonByIdentity(client, workspaceId, input.provider, input.externalId);
  if (existing) {
    if (existing.personId !== personId) return "taken";
    const raise = TRUST[input.status] > TRUST[existing.identity.status];
    const handleChanged = !!input.handle && input.handle !== existing.identity.handle;
    if (!raise && !handleChanged) return "unchanged";
    const { error } = await client
      .from("person_identities")
      .update({ ...(raise ? { status: input.status } : {}), ...(handleChanged ? { handle: input.handle } : {}) })
      .eq("id", existing.identity.id)
      .eq("workspace_id", workspaceId);
    if (error) throw error;
    return raise ? "raised" : "unchanged";
  }

  const { error } = await client.from("person_identities").insert({
    workspace_id: workspaceId,
    person_id: personId,
    provider: input.provider,
    external_id: input.externalId,
    handle: input.handle ?? null,
    status: input.status,
    source_connection_id: input.sourceConnectionId ?? null,
    evidence: input.evidence ?? {},
  });
  // Another sync added it first.
  if (error?.code === UNIQUE_VIOLATION) return "unchanged";
  if (error) throw error;
  return "created";
}

/** Makes a teammate who is not a Draft user yet: an active person, added by a connection. */
export async function createConnectionPerson(client: SupabaseClient, workspaceId: string, displayName: string): Promise<string> {
  const { data, error } = await client
    .from("people")
    .insert({ workspace_id: workspaceId, display_name: displayName, status: "active", created_by: "connection" })
    .select("id");
  if (error) throw error;
  return (data as Array<{ id: string }>)[0]!.id;
}

/**
 * Finds the person for a directory entry (a Slack or Linear user) by email, or makes one. Then adds the
 * provider identity as `from_connection`. Returns what happened, for counting.
 */
export async function matchOrCreateFromDirectory(
  client: SupabaseClient,
  workspaceId: string,
  entry: { provider: PersonIdentityProvider; externalId: string; handle: string | null; displayName: string; email: string },
  sourceConnectionId: string,
): Promise<"matched" | "created" | "known"> {
  const email = normalizeEmail(entry.email);
  const provider = await findPersonByIdentity(client, workspaceId, entry.provider, entry.externalId);
  const byEmail = provider ?? (await findPersonByIdentity(client, workspaceId, "email", email));

  let personId = byEmail?.personId;
  let outcome: "matched" | "created" | "known" = provider ? "known" : "matched";
  if (!personId) {
    personId = await createConnectionPerson(client, workspaceId, entry.displayName);
    outcome = "created";
    await addIdentity(client, workspaceId, personId, { provider: "email", externalId: email, handle: email, status: "from_connection", sourceConnectionId });
  }
  await addIdentity(client, workspaceId, personId, {
    provider: entry.provider,
    externalId: entry.externalId,
    handle: entry.handle,
    status: "from_connection",
    sourceConnectionId,
  });
  return outcome;
}
