import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveProviderCredential } from "../credentials/resolve-provider-credential";
import { listPublicSlackChannels, reconcileSlackChannels, SlackProviderError, type SlackReconcileFailure } from "../ingestion/slack/provider";

const MAX_RECONCILE_ATTEMPTS = 3;
const MAX_NAMES_IN_MESSAGE = 20;

export type SlackMembershipResult =
  | {
      ok: true;
      channelIds: string[];
      joined: string[];
      left: string[];
      failed: Array<{ channelId: string; operation: "join" | "leave"; code: SlackReconcileFailure["code"] }>;
    }
  | { ok: false; code: string; status: 404 | 409 | 500 | 502; error?: unknown };

const stringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];

/** Makes the bot's Slack channels exactly these. A concurrent change to the connection is retried, then reported as a conflict. */
export async function setSlackChannelMembership(client: SupabaseClient, workspaceId: string, desiredChannelIds: string[]): Promise<SlackMembershipResult> {
  let botToken: string | null = null;

  for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
    const { data: connection, error: connectionError } = await client
      .from("connections")
      .select("id, config_json, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("provider", "slack")
      .in("status", ["active", "degraded"])
      .maybeSingle();
    if (connectionError) return { ok: false, code: "connection_lookup_failed", status: 500, error: connectionError };
    if (!connection) return { ok: false, code: "not_found", status: 404 };

    if (!botToken) {
      try {
        botToken = (await resolveProviderCredential(workspaceId, "slack", client)).bot_token;
      } catch (error) {
        return { ok: false, code: error instanceof SlackProviderError ? error.code : "slack_channel_reconcile_failed", status: 502, error };
      }
    }

    const reconciliation = await reconcileSlackChannels(botToken, stringArray(connection.config_json?.channel_ids), desiredChannelIds);
    const existingConfig = connection.config_json && typeof connection.config_json === "object" && !Array.isArray(connection.config_json) ? connection.config_json : {};
    const { data: updatedConnection, error: updateError } = await client
      .from("connections")
      .update({ config_json: { ...existingConfig, channel_ids: reconciliation.channelIds } })
      .eq("id", connection.id)
      .eq("workspace_id", workspaceId)
      .eq("updated_at", connection.updated_at)
      .in("status", ["active", "degraded"])
      .select("id")
      .maybeSingle();
    if (updateError) return { ok: false, code: "connection_update_failed", status: 500, error: updateError };
    if (!updatedConnection) continue;

    return {
      ok: true,
      channelIds: reconciliation.channelIds,
      joined: reconciliation.joined,
      left: reconciliation.left,
      failed: reconciliation.failed.map((failure) => ({ channelId: failure.channelId, operation: failure.operation, code: failure.code })),
    };
  }
  return { ok: false, code: "connection_update_conflict", status: 409 };
}

export type SlackChannelEntries = { ok: true; channelIds: string[] } | { ok: false; code: string; message: string };

const normalized = (value: string) => value.replace(/^#/, "").toLowerCase();

/** Turns channel ids and #names into the ids of public channels the bot can join. A name that matches nothing is reported with examples. */
export async function resolveSlackChannelEntries(client: SupabaseClient, workspaceId: string, entries: string[]): Promise<SlackChannelEntries> {
  let channels;
  try {
    const credential = await resolveProviderCredential(workspaceId, "slack", client);
    channels = await listPublicSlackChannels(credential.bot_token);
  } catch {
    return { ok: false, code: "slack_channel_list_failed", message: "Could not list Slack channels. Check the connection and try again." };
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const wanted = normalized(entry);
    const match = channels.find((channel) => channel.id === entry || normalized(channel.name) === wanted);
    if (!match) {
      const examples = channels.slice(0, MAX_NAMES_IN_MESSAGE).map((channel) => `#${channel.name}`).join(", ");
      return { ok: false, code: "channel_not_found", message: `No public Slack channel matches "${entry}". Public channels include: ${examples || "none"}.` };
    }
    ids.push(match.id);
  }
  return { ok: true, channelIds: ids };
}
