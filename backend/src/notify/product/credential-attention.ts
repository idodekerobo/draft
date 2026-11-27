import type { SupabaseClient } from "@supabase/supabase-js";
import type { NotifyChannelId } from "draft-core/notify";
import { CredentialError } from "../../credentials/crypto";
import { recordError } from "../../errors/record-error";
import type { NotifyChannel } from "../delivery/types";

const SUBJECT = "Your Claude login stopped working";
const TEXT = "Draft can't use the workspace's Claude login anymore, so Home and cloud sessions can't run. Reconnect it to fix this.";

/** The people to tell: whoever saved the login, or the workspace's admins when nobody did or they left. */
export async function recipientPersonIds(client: SupabaseClient, workspaceId: string, ownerUserId: string | null): Promise<string[]> {
  const { data: workspace, error } = await client.from("workspaces").select("team_id").eq("id", workspaceId).maybeSingle();
  if (error) throw error;
  const teamId = (workspace as { team_id: string | null } | null)?.team_id;
  if (!teamId) return [];

  let userIds: string[] = [];
  if (ownerUserId) {
    const { data, error: ownerError } = await client.from("users").select("id").eq("id", ownerUserId).eq("primary_team_id", teamId).eq("status", "active");
    if (ownerError) throw ownerError;
    userIds = ((data ?? []) as Array<{ id: string }>).map((user) => user.id);
  }
  if (!userIds.length) {
    const { data, error: adminError } = await client.from("users").select("id").eq("primary_team_id", teamId).eq("status", "active").in("organization_role", ["owner", "admin"]);
    if (adminError) throw adminError;
    userIds = ((data ?? []) as Array<{ id: string }>).map((user) => user.id);
  }
  if (!userIds.length) return [];

  const { data: people, error: peopleError } = await client.from("people").select("id").eq("workspace_id", workspaceId).in("user_id", userIds);
  if (peopleError) throw peopleError;
  return ((people ?? []) as Array<{ id: string }>).map((person) => person.id);
}

/**
 * Tells the person who owns a login that it stopped working. The key names the login and the moment it was last saved,
 * so a restart or a second failure does not send a second notice, and saving a new login starts a new episode.
 */
export async function notifyCredentialAttention(
  client: SupabaseClient,
  channels: Record<NotifyChannelId, NotifyChannel>,
  workspaceId: string,
  credentialId: string,
): Promise<void> {
  const { data, error } = await client.from("credentials").select("created_by_user_id, updated_at").eq("id", credentialId).eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw error;
  if (!data) return;
  const credential = data as { created_by_user_id: string | null; updated_at: string };
  // Loaded here so that saving a login, which only needs to close notices, does not load the delivery channels and their settings.
  const { deliverNotification } = await import("../delivery/deliver");
  const { isFailure, resolvePerson } = await import("../delivery/resolve-person");

  for (const personId of await recipientPersonIds(client, workspaceId, credential.created_by_user_id)) {
    const recipient = await resolvePerson(client, workspaceId, personId);
    if (isFailure(recipient)) continue;
    try {
      const result = await deliverNotification(client, channels, recipient, {
        text: TEXT,
        subject: SUBJECT,
        attribution: "Sent by Draft · Workspace connections",
        action: { kind: "connection_attention", refType: "credential", refId: credentialId },
        idempotencyKey: `credential:${credentialId}:${credential.updated_at}:${recipient.id}`,
        origin: { senderUserId: null, agentRunId: null, scheduledTaskId: null },
      });
      if (!result.ok) throw new Error(result.code);
    } catch (cause) {
      await recordError({ client, workspaceId, operation: "delivery", code: "product_notification_failed", message: "Login notice could not be recorded", detail: { credentialId, recipientPersonId: recipient.id }, error: cause });
    }
  }
}

/** Closes the open notices about a login once it has been saved again. */
export async function clearCredentialAttention(client: SupabaseClient, workspaceId: string, credentialId: string): Promise<void> {
  const { error } = await client
    .from("notifications")
    .update({ state: "done", acted_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId)
    .eq("kind", "connection_attention")
    .eq("ref_type", "credential")
    .eq("ref_id", credentialId)
    .eq("state", "open");
  if (error) throw error;
}

/**
 * Tells the owner when a login fails because it was revoked, expired or cannot be read. A missing login is not a failure
 * of one that worked, so it stays quiet. Never throws: the caller is already handling the failure.
 */
export async function reportCredentialFailure(client: SupabaseClient, workspaceId: string, failure: unknown): Promise<void> {
  if (!(failure instanceof CredentialError) || failure.reason === "missing" || !failure.credentialId) return;
  try {
    const { defaultChannels } = await import("../delivery/send");
    await notifyCredentialAttention(client, defaultChannels(client), workspaceId, failure.credentialId);
  } catch (cause) {
    await recordError({ client, workspaceId, operation: "delivery", code: "product_notification_failed", message: "Login notice could not be recorded", detail: { credentialId: failure.credentialId }, error: cause });
  }
}
