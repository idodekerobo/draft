import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotifyChannelId } from "draft-core/notify";
import type { NotifyChannel } from "../notify/types";
import { isFailure, resolvePerson } from "../notify/resolve-person";
import { sendNotification } from "../notify/send";
import type { PersonView } from "./view";

/**
 * Tells each admin who can be reached that someone is waiting for approval. The gateway sends this after a person
 * is added, so it carries the same agent line as any message a run sends. A failed message never fails the add.
 */
export async function notifyAdminsOfPending(
  client: SupabaseClient,
  channels: Record<NotifyChannelId, NotifyChannel>,
  workspaceId: string,
  pending: PersonView,
  evidence: { sourceItemId?: string; quote: string },
  line: string,
): Promise<void> {
  const { data: workspace, error: workspaceError } = await client.from("workspaces").select("team_id").eq("id", workspaceId).maybeSingle();
  if (workspaceError) throw workspaceError;
  if (!workspace?.team_id) return;

  const { data: admins, error: adminsError } = await client
    .from("users")
    .select("id")
    .eq("primary_team_id", workspace.team_id)
    .eq("status", "active")
    .in("organization_role", ["owner", "admin"]);
  if (adminsError) throw adminsError;
  const adminIds = (admins ?? []).map((admin: { id: string }) => admin.id);
  if (!adminIds.length) return;

  const { data: people, error: peopleError } = await client.from("people").select("id").eq("workspace_id", workspaceId).in("user_id", adminIds);
  if (peopleError) throw peopleError;

  let where = "a source";
  if (evidence.sourceItemId) {
    // Only a shared source may be named: a model could pass the id of a private one, and admins may not see it.
    const { data: source } = await client.from("source_items").select("metadata_json").eq("id", evidence.sourceItemId).eq("workspace_id", workspaceId).eq("visibility", "shared").maybeSingle();
    const title = (source as { metadata_json?: { title?: unknown } } | null)?.metadata_json?.title;
    if (typeof title === "string" && title.trim()) where = `"${title.trim().slice(0, 80)}"`;
  }
  const quote = evidence.quote.slice(0, 200);
  const text =
    `${line}\nDraft found ${pending.displayName} in ${where}: "${quote}"\n` +
    `To add them, ask Claude "approve ${pending.displayName} in Draft", or run \`draft people approve ${pending.id}\`.`;

  for (const row of (people ?? []) as Array<{ id: string }>) {
    const admin = await resolvePerson(client, workspaceId, row.id);
    if (isFailure(admin)) continue;
    await sendNotification(channels, admin, { text }).catch(() => undefined);
  }
}
