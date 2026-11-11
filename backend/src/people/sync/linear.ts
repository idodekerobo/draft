import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchLinearUsers, type LinearDirectoryUser } from "../../ingestion/linear/users";
import { matchOrCreateFromDirectory } from "../match";
import type { SyncCounts, SyncDeps } from "./index";

/** Matches Linear users to people by email, or adds them. */
export async function syncLinearIdentities(
  client: SupabaseClient,
  connection: { id: string; workspace_id: string; credential_id: string },
  deps: SyncDeps & { fetchUsers?: (apiToken: string) => Promise<LinearDirectoryUser[]> } = {},
): Promise<SyncCounts> {
  const counts: SyncCounts = { matched: 0, created: 0, known: 0, skipped: 0 };
  const { api_token } = await deps.resolveCredential!(connection.workspace_id, "linear", connection.credential_id, client);
  const users = await (deps.fetchUsers ?? fetchLinearUsers)(api_token as string);
  for (const user of users) {
    counts[await matchOrCreateFromDirectory(client, connection.workspace_id, { provider: "linear", externalId: user.id, handle: user.name, displayName: user.name, email: user.email }, connection.id)] += 1;
  }
  return counts;
}
