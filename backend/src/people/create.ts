import type { SupabaseClient } from "@supabase/supabase-js";
import type { PeopleRow, PersonIdentityProvider } from "../types/tables";
import { addIdentity, findPersonByIdentity } from "./match";
import { viewPeople, type PersonView } from "./view";

export interface NewIdentity {
  provider: PersonIdentityProvider;
  externalId: string;
  handle?: string | null;
}

/** Who is adding the person. A run is the actor and a user lent it authority. A person is both. */
export type CreateActor =
  | { type: "run"; runId: string; onBehalfOf: string | null }
  | { type: "user"; userId: string; isAdmin: boolean };

export interface CreatePersonInput {
  displayName: string;
  evidence: { sourceItemId?: string; quote: string };
  identities?: ReadonlyArray<NewIdentity>;
  force?: boolean;
}

export type CreatePersonResult =
  | { created: true; person: PersonView }
  | { created: false; person: PersonView }
  | { created: false; candidates: PersonView[] }
  | { created: false; rejected: true };

const words = (name: string) => name.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** A close match: the same name ignoring case, or the same first name. Simple on purpose. */
function closeName(a: string, b: string): boolean {
  const [first, second] = [words(a), words(b)];
  if (!first.length || !second.length) return false;
  return first.join(" ") === second.join(" ") || first[0] === second[0];
}

/**
 * Adds a person, unless Draft already knows them. The checks run here on the server, in this order:
 * an identity that already belongs to someone returns that person; a close name among rejected people is refused,
 * so synthesis cannot add them back every night; a close name among current people returns candidates unless
 * `force` is set. `force` never skips the identity or rejected checks.
 */
export async function createPerson(client: SupabaseClient, workspaceId: string, actor: CreateActor, input: CreatePersonInput): Promise<CreatePersonResult> {
  for (const identity of input.identities ?? []) {
    const known = await findPersonByIdentity(client, workspaceId, identity.provider, identity.externalId);
    if (!known) continue;
    const { data, error } = await client.from("people").select("*").eq("id", known.personId).eq("workspace_id", workspaceId).maybeSingle();
    if (error) throw error;
    const row = data as PeopleRow | null;
    if (!row) continue;
    if (row.status === "rejected") return { created: false, rejected: true };
    return { created: false, person: (await viewPeople(client, workspaceId, [row]))[0]! };
  }

  const { data: existing, error: existingError } = await client.from("people").select("*").eq("workspace_id", workspaceId);
  if (existingError) throw existingError;
  const similar = ((existing ?? []) as PeopleRow[]).filter((row) => closeName(row.display_name, input.displayName));
  if (similar.some((row) => row.status === "rejected")) return { created: false, rejected: true };
  const current = similar.filter((row) => row.status !== "rejected");
  if (current.length > 0 && !input.force) return { created: false, candidates: await viewPeople(client, workspaceId, current) };

  const byRun = actor.type === "run";
  const { data, error } = await client
    .from("people")
    .insert({
      workspace_id: workspaceId,
      display_name: input.displayName.trim(),
      // A teammate's addition waits for an admin. An admin's addition is already approved.
      status: !byRun && actor.isAdmin ? "active" : "pending",
      created_by: byRun ? "agent" : "user",
      ...(byRun
        ? { created_by_run_id: actor.runId, on_behalf_of_user_id: actor.onBehalfOf }
        : { created_by_user_id: actor.userId }),
      evidence: input.evidence,
    })
    .select("*");
  if (error) throw error;
  const row = (data as PeopleRow[])[0]!;

  // What an agent or a teammate says about a person is never proof. Only a connection or the person's own account proves it.
  for (const identity of input.identities ?? []) {
    await addIdentity(client, workspaceId, row.id, {
      provider: identity.provider,
      externalId: identity.provider === "email" ? identity.externalId.trim().toLowerCase() : identity.externalId,
      handle: identity.handle ?? null,
      status: "inferred",
      evidence: input.evidence,
    });
  }
  return { created: true, person: (await viewPeople(client, workspaceId, [row]))[0]! };
}
