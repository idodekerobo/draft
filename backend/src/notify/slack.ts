import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelSendResult, NotifyMessage } from "draft-core/notify";
import { resolveProviderCredentialById } from "../credentials/resolve-provider-credential";
import { openSlackDm, postSlackMessage } from "../ingestion/slack/post";
import type { PersonIdentityRow } from "../types/tables";
import type { NotifyChannel, ReachablePerson } from "./types";

export interface SlackChannelDeps {
  resolveBotToken?: (workspaceId: string, credentialId: string) => Promise<string>;
  openDm?: (botToken: string, slackUserId: string) => Promise<string>;
  postMessage?: (botToken: string, channel: string, text: string) => Promise<void>;
}

const TRUSTED = ["confirmed", "from_connection"];

/** `text`, then the link on its own line when there is one. */
export const renderSlackText = (message: NotifyMessage) => (message.link ? `${message.text}\n${message.link}` : message.text);

/** Messages a person as a Slack direct message from the workspace's connected app. */
export function slackChannel(client: SupabaseClient, deps: SlackChannelDeps = {}): NotifyChannel {
  const resolveBotToken =
    deps.resolveBotToken ?? (async (workspaceId, credentialId) => (await resolveProviderCredentialById(workspaceId, "slack", credentialId, client)).bot_token);
  const openDm = deps.openDm ?? openSlackDm;
  const postMessage = deps.postMessage ?? postSlackMessage;

  async function target(person: ReachablePerson): Promise<{ slackUserId: string; credentialId: string } | null> {
    const { data: identities, error } = await client
      .from("person_identities")
      .select("external_id, status")
      .eq("workspace_id", person.workspaceId)
      .eq("person_id", person.id)
      .eq("provider", "slack");
    if (error) throw error;
    const trusted = ((identities ?? []) as Array<Pick<PersonIdentityRow, "external_id" | "status">>).find((identity) => TRUSTED.includes(identity.status));
    if (!trusted) return null;

    const { data: connection, error: connectionError } = await client
      .from("source_connections")
      .select("credential_id")
      .eq("workspace_id", person.workspaceId)
      .eq("provider", "slack")
      .eq("status", "active")
      .maybeSingle();
    if (connectionError) throw connectionError;
    const credentialId = (connection as { credential_id: string | null } | null)?.credential_id;
    return credentialId ? { slackUserId: trusted.external_id, credentialId } : null;
  }

  return {
    id: "slack",
    canReach: async (person) => (await target(person)) !== null,
    async send(person, message): Promise<ChannelSendResult> {
      const found = await target(person);
      if (!found) return { channel: "slack", status: "failed", code: "not_reachable" };
      try {
        const botToken = await resolveBotToken(person.workspaceId, found.credentialId);
        const channel = await openDm(botToken, found.slackUserId);
        await postMessage(botToken, channel, renderSlackText(message));
        return { channel: "slack", status: "sent" };
      } catch {
        return { channel: "slack", status: "failed", code: "provider_error" };
      }
    },
  };
}
