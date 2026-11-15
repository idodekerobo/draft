import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { findToolPermission, type DraftToolLimits, type ToolCaller } from "draft-core/tools";
import { fetchSlackConversationHistory, listSlackChannels } from "draft-core/integrations/slack-hosted";
import { attributionLine } from "../../../notify/attribution";
import { workspaceSlackCredentialId, resolveWorkspaceSlackBotToken } from "../../../notify/slack-connection";
import { postSlackMessage } from "../../../ingestion/slack/post";
import { countRunToolCalls } from "../../../people/limits";
import { defineTool, refuse } from "../tool-registry";
import { callerWorkspaceId } from "./shared";

export interface SlackToolDeps {
  fetch?: typeof fetch;
  credentialId?: (workspaceId: string) => Promise<string | null>;
  botToken?: (workspaceId: string, credentialId: string) => Promise<string>;
  post?: typeof postSlackMessage;
  attribution?: (caller: ToolCaller) => Promise<string>;
  countCalls?: (runId: string, toolName: string) => Promise<number>;
}

const normalized = (value: string) => value.replace(/^#/, "").toLowerCase();

export function createSlackTools(client: SupabaseClient, deps: SlackToolDeps = {}) {
  const fetchFn = deps.fetch ?? fetch;
  const getCredentialId = deps.credentialId ?? ((workspaceId) => workspaceSlackCredentialId(client, workspaceId));
  const getBotToken = deps.botToken ?? ((workspaceId, id) => resolveWorkspaceSlackBotToken(client, workspaceId, id));
  const post = deps.post ?? postSlackMessage;
  const getAttribution = deps.attribution ?? ((caller) => attributionLine(client, caller));
  const countCalls = deps.countCalls ?? ((runId, tool) => countRunToolCalls(client, runId, tool));

  async function channels(workspaceId: string) {
    const id = await getCredentialId(workspaceId);
    if (!id) return { ok: false as const, error: "Slack is not connected for this workspace." };
    const token = await getBotToken(workspaceId, id);
    const result = await listSlackChannels(token, "public_channel,private_channel", fetchFn);
    return { ok: true as const, channels: result.filter((channel) => channel.isMember).map(({ id: channelId, name }) => ({ id: channelId, name })) };
  }

  async function resolveChannel(workspaceId: string, value: string) {
    const result = await channels(workspaceId);
    if (!result.ok) return result;
    const wanted = normalized(value);
    const channel = result.channels.find((item) => item.id === value || normalized(item.name) === wanted);
    return channel ? { ok: true as const, channel } : { ok: false as const, error: "The bot is not a member of that Slack channel." };
  }

  const list = defineTool({
    name: "slack.list_channels", mcp: true,
    description: "List Slack channels Draft's bot has joined. Use a returned id or #name with slack.read_channel and slack.post_message.",
    input: z.object({}),
    handler: async ({ caller }) => {
      try {
        const result = await channels(callerWorkspaceId(caller));
        return !result.ok ? refuse("slack_not_connected", result.error) : { status: "ok", output: result.channels };
      } catch { return refuse("slack_unavailable", "Could not list Slack channels. Check the connection and try again."); }
    },
  });

  const read = defineTool({
    name: "slack.read_channel", mcp: true,
    description: "Read recent messages from a Slack channel the bot has joined. Read this before posting and do not repeat a message already sent.",
    input: z.object({ channel: z.string().min(1).describe("A channel id or #channel-name from slack.list_channels."), limit: z.number().int().min(1).max(50).optional() }),
    handler: async ({ input, caller }) => {
      const workspaceId = callerWorkspaceId(caller);
      try {
        const found = await resolveChannel(workspaceId, input.channel);
        if (!found.ok) return refuse("channel_not_allowed", found.error);
        const id = await getCredentialId(workspaceId);
        if (!id) return refuse("slack_not_connected", "Slack is not connected for this workspace.");
        const token = await getBotToken(workspaceId, id);
        const page = await fetchSlackConversationHistory(token, found.channel.id, { limit: input.limit ?? 20 }, fetchFn);
        return { status: "ok", output: { channel: found.channel, messages: page.messages.slice(0, input.limit ?? 20), has_more: page.hasMore } };
      } catch { return refuse("slack_unavailable", "Could not read recent Slack messages. Check the connection and try again."); }
    },
  });

  const postMessage = defineTool({
    name: "slack.post_message", mcp: true,
    description: "Post a message to a joined Slack channel. Read recent messages with slack.read_channel first and do not repeat a message already sent. Draft adds an attribution line automatically.",
    input: z.object({ channel: z.string().min(1).describe("A channel id or #channel-name from slack.list_channels."), text: z.string().min(1).max(4000) }),
    auditArguments: (input) => ({ channel: input.channel, textBytes: Buffer.byteLength(input.text, "utf8") }),
    handler: async ({ input, caller }) => {
      const workspaceId = callerWorkspaceId(caller);
      if (caller.type === "run") {
        const limits = findToolPermission(caller.run, "slack.post_message")?.limits as DraftToolLimits["slack.post_message"] | undefined;
        const max = limits?.maxPerRun ?? 10;
        if ((await countCalls(caller.run.id, "slack.post_message")) >= max) return refuse("limit_reached", `This run has posted ${max} Slack messages, its limit.`);
      }
      try {
        const found = await resolveChannel(workspaceId, input.channel);
        if (!found.ok) return refuse("channel_not_allowed", found.error);
        if (caller.type === "run") {
          const limits = findToolPermission(caller.run, "slack.post_message")?.limits as DraftToolLimits["slack.post_message"] | undefined;
          const allowed = limits?.channels ?? "joined";
          if (allowed !== "joined" && !allowed.some((value) => value === found.channel.id || normalized(value) === normalized(found.channel.name))) {
            return refuse("channel_not_allowed", "This routine is not allowed to post in that channel.");
          }
        }
        const id = await getCredentialId(workspaceId);
        if (!id) return refuse("slack_not_connected", "Slack is not connected for this workspace.");
        const token = await getBotToken(workspaceId, id);
        await post(token, found.channel.id, `${await getAttribution(caller)}\n${input.text}`, fetchFn);
        return { status: "ok", output: { channel: found.channel }, summary: `Posted in #${found.channel.name}` };
      } catch { return refuse("slack_unavailable", "Could not post to Slack. Check the connection and try again."); }
    },
  });

  return [list, read, postMessage];
}
