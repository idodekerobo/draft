import type { SupabaseClient } from "@supabase/supabase-js";
import type { PeopleRow, PersonIdentityProvider } from "../types/tables";
import { normalizeEmail } from "./match";
import { viewPeople, type PersonView } from "./view";

export interface FindQuery {
  /** Set when the caller asked for themself: the user the call is for. */
  userId?: string;
  name?: string;
  email?: string;
  provider?: PersonIdentityProvider;
  externalId?: string;
  status?: PeopleRow["status"];
}

const MAX_RESULTS = 50;

async function personIdsForIdentity(client: SupabaseClient, workspaceId: string, provider: PersonIdentityProvider, externalId: string): Promise<string[]> {
  const { data, error } = await client
    .from("person_identities")
    .select("person_id")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .eq("external_id", externalId);
  if (error) throw error;
  return (data ?? []).map((row: { person_id: string }) => row.person_id);
}

export async function findPeopleRows(client: SupabaseClient, workspaceId: string, query: FindQuery): Promise<PeopleRow[]> {
  let ids: string[] | null = null;
  const narrow = (found: string[]) => {
    ids = ids ? ids.filter((id) => found.includes(id)) : found;
  };
  if (query.email) narrow(await personIdsForIdentity(client, workspaceId, "email", normalizeEmail(query.email)));
  if (query.provider && query.externalId) narrow(await personIdsForIdentity(client, workspaceId, query.provider, query.externalId));
  if (ids !== null && (ids as string[]).length === 0) return [];

  let select = client.from("people").select("*").eq("workspace_id", workspaceId);
  if (query.status) select = select.eq("status", query.status);
  if (query.userId) select = select.eq("user_id", query.userId);
  if (ids !== null) select = select.in("id", ids);
  const { data, error } = await select.limit(500);
  if (error) throw error;

  let rows = (data ?? []) as PeopleRow[];
  if (query.name) {
    const wanted = query.name.trim().toLowerCase();
    rows = rows.filter((row) => row.display_name.toLowerCase().includes(wanted));
  }
  return rows.slice(0, MAX_RESULTS);
}

export async function findPeople(client: SupabaseClient, workspaceId: string, query: FindQuery): Promise<PersonView[]> {
  return viewPeople(client, workspaceId, await findPeopleRows(client, workspaceId, query));
}
