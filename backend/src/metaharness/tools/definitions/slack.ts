import type { SupabaseClient } from "@supabase/supabase-js";
import { findToolPermission, type DraftToolLimits, type ToolCaller } from "draft-core/tools";
import { fetchSlackConversationHistory, listSlackChannels } from "draft-core/integrations/slack-hosted";
import { attributionLine } from "../../../notify/attribution";
import { workspaceSlackCredentialId, resolveWorkspaceSlackBotToken } from "../../../notify/slack-connection";
import { postSlackMessage } from "../../../ingestion/slack/post";
import { countRunToolCalls } from "../../../people/limits";
import { refuse, type ToolHandlerResult } from "../tool-registry";
import { callerWorkspaceId } from "./shared";

export interface SlackDeps {
  fetch?: typeof fetch;
  credentialId?: (workspaceId: string) => Promise<string | null>;
  botToken?: (workspaceId: string, credentialId: string) => Promise<string>;
  post?: typeof postSlackMessage;
  attribution?: (caller: ToolCaller) => Promise<string>;
  countCalls?: (runId: string, toolName: string, provider: string) => Promise<number>;
}

export type SlackChannelRef = { id: string; name: string };
export type SlackChannelsResult = { ok: true; channels: SlackChannelRef[] } | { ok: false; error: string };

const normalized = (value: string) => value.replace(/^#/, "").toLowerCase();
const NOT_CONNECTED = "Slack is not connected for this workspace. A person can connect it with connections.connect.";
const joinedList = (channels: SlackChannelRef[]) => (channels.length ? channels.map((channel) => `#${channel.name}`).join(", ") : "none yet");

/** How Slack answers the `connections.*` verbs. The tools dispatch here by provider; permissions are checked before this runs. */
export function createSlackProvider(client: SupabaseClient, deps: SlackDeps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const getCredentialId = deps.credentialId ?? ((workspaceId) => workspaceSlackCredentialId(client, workspaceId));
  const getBotToken = deps.botToken ?? ((workspaceId, id) => resolveWorkspaceSlackBotToken(client, workspaceId, id));
  const post = deps.post ?? postSlackMessage;
  const getAttribution = deps.attribution ?? ((caller) => attributionLine(client, caller));
  const countCalls = deps.countCalls ?? ((runId, tool, provider) => countRunToolCalls(client, runId, tool, provider));

  /** The channels the bot has joined. */
  async function listChannels(workspaceId: string): Promise<SlackChannelsResult> {
    const id = await getCredentialId(workspaceId);
    if (!id) return { ok: false, error: NOT_CONNECTED };
    const token = await getBotToken(workspaceId, id);
    const result = await listSlackChannels(token, "public_channel,private_channel", fetchFn);
    return { ok: true, channels: result.filter((channel) => channel.isMember).map(({ id: channelId, name }) => ({ id: channelId, name })) };
  }

  async function resolveChannel(workspaceId: string, value: string) {
    const result = await listChannels(workspaceId);
    if (!result.ok) return result;
    const wanted = normalized(value);
    const channel = result.channels.find((item) => item.id === value || normalized(item.name) === wanted);
    return channel
      ? { ok: true as const, channel }
      : { ok: false as const, error: `The bot is not a member of that Slack channel. Channels it has joined: ${joinedList(result.channels)}.` };
  }

  async function read(caller: ToolCaller, input: { channel: string; limit?: number }): Promise<ToolHandlerResult> {
    const workspaceId = callerWorkspaceId(caller);
    try {
      const found = await resolveChannel(workspaceId, input.channel);
      if (!found.ok) return refuse(found.error === NOT_CONNECTED ? "slack_not_connected" : "channel_not_allowed", found.error);
      const id = await getCredentialId(workspaceId);
      if (!id) return refuse("slack_not_connected", NOT_CONNECTED);
      const token = await getBotToken(workspaceId, id);
      const limit = input.limit ?? 20;
      const page = await fetchSlackConversationHistory(token, found.channel.id, { limit }, fetchFn);
      return { status: "ok", output: { provider: "slack", channel: found.channel, messages: page.messages.slice(0, limit), has_more: page.hasMore } };
    } catch {
      return refuse("slack_unavailable", "Could not read recent Slack messages. Check the connection and try again.");
    }
  }

  async function postMessage(caller: ToolCaller, input: { channel: string; text: string }): Promise<ToolHandlerResult> {
    const workspaceId = callerWorkspaceId(caller);
    const grant = caller.origin.kind === "run" ? findToolPermission(caller.origin.run, "connections.post", "slack") : null;
    const limits = grant?.limits as DraftToolLimits["connections.post"] | undefined;
    if (caller.origin.kind === "run") {
      const max = limits?.maxPerRun ?? 10;
      if ((await countCalls(caller.origin.run.id, "connections.post", "slack")) >= max) return refuse("limit_reached", `This run has posted ${max} Slack messages, its limit.`);
    }
    try {
      const found = await resolveChannel(workspaceId, input.channel);
      if (!found.ok) return refuse(found.error === NOT_CONNECTED ? "slack_not_connected" : "channel_not_allowed", found.error);
      if (caller.origin.kind === "run") {
        const allowed = limits?.channels ?? "joined";
        if (allowed !== "joined" && !allowed.some((value) => value === found.channel.id || normalized(value) === normalized(found.channel.name))) {
          return refuse("channel_not_allowed", `This routine is not allowed to post in that channel. It may post in: ${allowed.join(", ")}.`);
        }
      }
      const id = await getCredentialId(workspaceId);
      if (!id) return refuse("slack_not_connected", NOT_CONNECTED);
      const token = await getBotToken(workspaceId, id);
      await post(token, found.channel.id, `${await getAttribution(caller)}\n${input.text}`, fetchFn);
      return { status: "ok", output: { provider: "slack", channel: found.channel }, summary: `Posted in #${found.channel.name}` };
    } catch {
      return refuse("slack_unavailable", "Could not post to Slack. Check the connection and try again.");
    }
  }

  return { listChannels, read, post: postMessage };
}
