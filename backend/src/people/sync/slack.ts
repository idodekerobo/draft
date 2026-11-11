import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchSlackUsers, type SlackUsersResult } from "../../ingestion/slack/users";
import { matchOrCreateFromDirectory } from "../match";
import type { SyncCounts, SyncDeps } from "./index";

/** Matches Slack members to people by email, or adds them. Without the email scope it adds nothing. */
export async function syncSlackIdentities(
  client: SupabaseClient,
  connection: { id: string; workspace_id: string; credential_id: string },
  deps: SyncDeps & { fetchUsers?: (botToken: string) => Promise<SlackUsersResult> } = {},
): Promise<SyncCounts> {
  const counts: SyncCounts = { matched: 0, created: 0, known: 0, skipped: 0 };
  const { bot_token } = await deps.resolveCredential!(connection.workspace_id, "slack", connection.credential_id, client);
  const { users, sawPeopleWithoutEmail } = await (deps.fetchUsers ?? fetchSlackUsers)(bot_token as string);

  if (sawPeopleWithoutEmail) {
    await deps.recordWarning?.(connection, "slack_email_scope_missing", "Slack returned no emails. Reinstall the app with the users:read.email scope.");
    counts.skipped = users.length;
    return counts;
  }
  for (const user of users) {
    if (!user.email) {
      counts.skipped += 1;
      continue;
    }
    counts[await matchOrCreateFromDirectory(client, connection.workspace_id, { provider: "slack", externalId: user.id, handle: user.name, displayName: user.name, email: user.email }, connection.id)] += 1;
  }
  return counts;
}
