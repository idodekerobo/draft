import type { SupabaseClient } from "@supabase/supabase-js";
import { findToolPermission, type DraftToolLimits, type ToolCaller } from "draft-core/tools";
import { fetchSlackConversationHistory, listSlackChannels } from "draft-core/integrations/slack-hosted";
import { attributionLine } from "../../../notify/attribution";
import { workspaceSlackCredentialId, resolveWorkspaceSlackBotToken } from "../../../notify/slack-connection";
import { postSlackMessage } from "../../../ingestion/slack/post";
import { countRunToolCalls } from "../../../people/limits";
import { listIntegrations } from "../../../integrations/service";
import { resolveSlackChannelEntries, updateSlackChannelMembership } from "../../../integrations/slack-channels";
import { refuse, type ToolHandlerResult } from "../tool-registry";
import { callerWorkspaceId, requireUser } from "../definitions/shared";
import type { ConnectionAdapter, ProviderAction } from "./types";

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

export type BrowsedSlackChannel = { id: string; name: string; memberCount: number; joined: boolean };
export type SlackBrowseResult =
  | { ok: true; channels: BrowsedSlackChannel[]; nextCursor: string | null }
  | { ok: false; code: string; error: string };

const encodeCursor = (offset: number) => Buffer.from(JSON.stringify({ offset })).toString("base64url");
function decodeCursor(cursor: string): number | null {
  try {
    const offset = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown }).offset;
    return typeof offset === "number" && Number.isInteger(offset) && offset >= 0 ? offset : null;
  } catch {
    return null;
  }
}

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

  /**
   * Every public channel, biggest first, with whether the bot is in it. Slack has no search or offset call, so each
   * request walks Slack's pages, then filters by name and slices.
   */
  async function browseChannels(workspaceId: string, options: { query?: string; limit: number; cursor?: string }): Promise<SlackBrowseResult> {
    const offset = options.cursor === undefined ? 0 : decodeCursor(options.cursor);
    if (offset === null) return { ok: false, code: "invalid_cursor", error: "That cursor is not one connections.list gave. Start again without a cursor." };
    const id = await getCredentialId(workspaceId);
    if (!id) return { ok: false, code: "slack_not_connected", error: NOT_CONNECTED };
    const token = await getBotToken(workspaceId, id);
    const wanted = options.query ? normalized(options.query) : null;
    const all = (await listSlackChannels(token, "public_channel", fetchFn))
      .filter((channel) => wanted === null || normalized(channel.name).includes(wanted))
      .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name));
    const page = all.slice(offset, offset + options.limit);
    return {
      ok: true,
      channels: page.map(({ id: channelId, name, memberCount, isMember }) => ({ id: channelId, name, memberCount, joined: isMember })),
      nextCursor: offset + options.limit < all.length ? encodeCursor(offset + options.limit) : null,
    };
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

  return { listChannels, browseChannels, read, post: postMessage };
}

export interface SlackChannelDeps {
  /** Tests pass their own. The defaults talk to Slack and the database. */
  resolve: typeof resolveSlackChannelEntries;
  update: typeof updateSlackChannelMembership;
}

const SLACK_ACTIONS: ReadonlyArray<ProviderAction> = [
  { verb: "read", description: "Read recent messages from a channel the bot has joined.", fields: { channel: "channel id or #name (required)", limit: "1 to 50 messages (optional, default 20)" } },
  { verb: "post", description: "Post a message to a channel the bot has joined.", fields: { channel: "channel id or #name (required)", text: "message text, up to 4000 characters (required)" } },
  { verb: "join", description: "Have the bot join public channels. It changes only the channels you name. Call connections.list with available: true to see which exist.", fields: { channels: "channel ids or #names to join (required)" }, personOnly: true },
  { verb: "leave", description: "Have the bot leave public channels. It changes only the channels you name.", fields: { channels: "channel ids or #names to leave (required)" }, personOnly: true },
];

/** Slack as a connection adapter: reading, posting, and choosing the channels the bot is in. */
export function createSlackAdapter(client: SupabaseClient, slackDeps: SlackDeps = {}, channelDeps: Partial<SlackChannelDeps> = {}): ConnectionAdapter {
  const slack = createSlackProvider(client, slackDeps);
  const resolveChannels = channelDeps.resolve ?? resolveSlackChannelEntries;
  const updateChannels = channelDeps.update ?? updateSlackChannelMembership;

  /** Joins or leaves only the channels named, and says which changed, which were already so, and which failed. */
  async function changeChannels(caller: ToolCaller, input: { channels?: string[] }, verb: "join" | "leave"): Promise<ToolHandlerResult> {
    const user = requireUser(caller, `connections.${verb}`);
    if (!input.channels?.length) return refuse("channels_required", `Slack ${verb} needs channels: the channel ids or #names to ${verb}.`);
    const state = (await listIntegrations(client, user.workspaceId, user.userId)).find((item) => item.provider === "slack");
    if (state?.status !== "connected") return refuse("not_connected", "Slack is not connected yet. Call connections.connect to get a link, then choose its channels.");
    const resolved = await resolveChannels(client, user.workspaceId, input.channels);
    if (!resolved.ok) return refuse(resolved.code, resolved.message);

    const wanted = new Set(resolved.channelIds);
    const result = await updateChannels(client, user.workspaceId, (current) => (verb === "join" ? [...new Set([...current, ...wanted])] : current.filter((id) => !wanted.has(id))));
    if (!result.ok) {
      return refuse(result.code, result.status === 409 ? "The Slack connection changed at the same time. Try again." : "Could not update the Slack channels. Try again shortly.");
    }

    const named = new Map(resolved.channels.map((channel) => [channel.id, channel.name]));
    const ref = (id: string) => ({ id, name: named.get(id) ?? id });
    const label = (ids: string[]) => ids.map((id) => `#${named.get(id) ?? id}`).join(", ");
    const changedIds = verb === "join" ? result.joined : result.left;
    const failedIds = result.failed.map((failure) => failure.channelId);
    const unchangedIds = resolved.channelIds.filter((id) => !changedIds.includes(id) && !failedIds.includes(id));
    const message = [
      changedIds.length ? `${verb === "join" ? "Joined" : "Left"} ${label(changedIds)}.` : null,
      unchangedIds.length ? `${verb === "join" ? "Already in" : "Was not in"} ${label(unchangedIds)}.` : null,
      failedIds.length ? `Could not ${verb} ${label(failedIds)}.` : null,
    ].filter(Boolean).join(" ");
    return {
      status: "ok",
      output: {
        status: verb === "join" ? "joined" : "left",
        provider: "slack",
        changed: changedIds.map(ref),
        unchanged: unchangedIds.map(ref),
        failed: result.failed.map((failure) => ({ ...ref(failure.channelId), code: failure.code })),
        message,
      },
      summary: message,
    };
  }

  return {
    provider: "slack",
    notConnectedMessage: NOT_CONNECTED,
    actions: SLACK_ACTIONS,
    read: ({ caller }, input) => (input.channel ? slack.read(caller, { channel: input.channel, limit: input.limit }) : Promise.resolve(refuse("channel_required", "Slack read needs channel: a channel id or #name the bot has joined."))),
    post: ({ caller }, input) => (input.channel ? slack.post(caller, { channel: input.channel, text: input.text }) : Promise.resolve(refuse("channel_required", "Slack post needs channel: a channel id or #name the bot has joined."))),
    join: ({ caller }, input) => changeChannels(caller, input, "join"),
    leave: ({ caller }, input) => changeChannels(caller, input, "leave"),
    describe: ({ caller }) => slack.listChannels(caller.workspaceId).then(
      (result) => (result.ok ? { channels: result.channels } : { channelsError: result.error }),
      () => ({ channelsError: "Could not list Slack channels. Try again shortly." }),
    ),
    browse: async ({ caller }, input) => {
      const page = await slack.browseChannels(caller.workspaceId, input).catch((): { ok: false; code: string; error: string } => ({ ok: false, code: "slack_unavailable", error: "Could not list Slack channels. Try again shortly." }));
      return page.ok ? { ok: true, fields: { available: { channels: page.channels, nextCursor: page.nextCursor } } } : page;
    },
    audit: (verb, input) => {
      if (verb === "read") return { provider: "slack", channel: input.channel, limit: input.limit ?? null };
      if (verb === "post") return { provider: "slack", channel: input.channel, textBytes: Buffer.byteLength(String(input.text ?? ""), "utf8") };
      if (verb === "join" || verb === "leave") return { provider: "slack", channelCount: Array.isArray(input.channels) ? input.channels.length : 0 };
      return { provider: "slack" };
    },
  };
}
