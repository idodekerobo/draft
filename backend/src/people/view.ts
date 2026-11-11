import type { SupabaseClient } from "@supabase/supabase-js";
import type { PeopleRow, PersonIdentityRow } from "../types/tables";

/**
 * What a tool tells a model about a person. No emails, Slack ids or phone numbers: the model does not need
 * them to act, and what it sees can leak into its output.
 */
export interface PersonView {
  id: string;
  displayName: string;
  status: PeopleRow["status"];
  isUser: boolean;
  reachable: { slack: boolean };
}

const TRUSTED = ["confirmed", "from_connection"] as const;

/** Builds views for these people. Slack is reachable when the person has a trusted Slack identity and the workspace has Slack connected. */
export async function viewPeople(client: SupabaseClient, workspaceId: string, rows: ReadonlyArray<PeopleRow>): Promise<PersonView[]> {
  if (!rows.length) return [];
  const { data: identities, error: identitiesError } = await client
    .from("person_identities")
    .select("person_id, status")
    .eq("workspace_id", workspaceId)
    .eq("provider", "slack")
    .in("person_id", rows.map((row) => row.id));
  if (identitiesError) throw identitiesError;
  const { data: connections, error: connectionsError } = await client
    .from("source_connections")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("provider", "slack")
    .eq("status", "active")
    .limit(1);
  if (connectionsError) throw connectionsError;
  const slackConnected = (connections ?? []).length > 0;
  const withSlack = new Set(
    ((identities ?? []) as Array<Pick<PersonIdentityRow, "person_id" | "status">>)
      .filter((identity) => (TRUSTED as ReadonlyArray<string>).includes(identity.status))
      .map((identity) => identity.person_id),
  );
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    isUser: row.user_id !== null && row.user_id !== undefined,
    reachable: { slack: slackConnected && withSlack.has(row.id) },
  }));
}
