import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCaller } from "draft-core/tools";
import { describeError } from "../../../errors/describe-error";
import { disconnectConnection } from "../../../integrations/disconnect";
import { INTEGRATION_PROVIDERS, createConnectRequest, listIntegrations, type IntegrationProvider } from "../../../integrations/service";
import { resolveSlackChannelEntries, setSlackChannelMembership } from "../../../integrations/slack-channels";
import type { ConnectionProvider } from "../../../types/enums";
import { defineTool, refuse } from "../tool-registry";
import { requireUser } from "./shared";
import { createSlackProvider, type SlackDeps } from "./slack";

interface ProviderAction {
  verb: string;
  description: string;
  fields: Record<string, string>;
  /** Only a signed-in person may do this. A run holds a permission for every other verb. */
  personOnly?: boolean;
}

/** What each provider lets a caller do beyond connecting it. The verbs and fields are those of the connections.* tools. */
const PROVIDER_ACTIONS: Partial<Record<IntegrationProvider, ReadonlyArray<ProviderAction>>> = {
  slack: [
    { verb: "read", description: "Read recent messages from a channel the bot has joined.", fields: { channel: "channel id or #name (required)", limit: "1 to 50 messages (optional, default 20)" } },
    { verb: "post", description: "Post a message to a channel the bot has joined.", fields: { channel: "channel id or #name (required)", text: "message text, up to 4000 characters (required)" } },
    { verb: "connect", description: "Change which public channels the bot joins. Call connections.connect with channels.", fields: { channels: "channel ids or #names the bot should be in, replacing the current set (optional)" }, personOnly: true },
  ],
};

const VERB_TOOL = { read: "connections.read", post: "connections.post" } as const;
const providersThatRead = (): string => Object.entries(PROVIDER_ACTIONS).filter(([, actions]) => actions?.some((action) => action.verb === "read")).map(([provider]) => provider).join(", ");
const providersThatPost = (): string => Object.entries(PROVIDER_ACTIONS).filter(([, actions]) => actions?.some((action) => action.verb === "post")).map(([provider]) => provider).join(", ");

export interface IntegrationToolDeps {
  slack?: SlackDeps;
  /** Tests pass their own. The defaults talk to Slack and the database. */
  slackChannels?: { resolve: typeof resolveSlackChannelEntries; set: typeof setSlackChannelMembership };
}

/** The person a call is for. A run acts for its owner. */
function actingUserId(caller: ToolCaller): string {
  return caller.origin.kind === "person" ? caller.origin.userId : (caller.onBehalfOf ?? "");
}

/** The providers a run may use for a tool, from its permissions. */
function grantedProviders(caller: ToolCaller, tool: string): Set<string> {
  if (caller.origin.kind !== "run") return new Set();
  return new Set(caller.origin.run.permissions.filter((permission) => permission.tool === tool && permission.provider).map((permission) => permission.provider!));
}

export function createIntegrationTools(client: SupabaseClient, deps: IntegrationToolDeps = {}) {
  const slack = createSlackProvider(client, deps.slack);
  const resolveChannels = deps.slackChannels?.resolve ?? resolveSlackChannelEntries;
  const setChannels = deps.slackChannels?.set ?? setSlackChannelMembership;

  /** The actions this caller may use on a provider: all of them for a person, only the permitted verbs for a run. */
  function actionsFor(caller: ToolCaller, provider: IntegrationProvider) {
    const actions = PROVIDER_ACTIONS[provider] ?? [];
    if (caller.origin.kind === "person") return actions.map(({ verb, description, fields }) => ({ verb, description, fields }));
    return actions
      .filter((action) => !action.personOnly && grantedProviders(caller, VERB_TOOL[action.verb as keyof typeof VERB_TOOL]).has(provider))
      .map(({ verb, description, fields }) => ({ verb, description, fields }));
  }

  const list = defineTool({
    name: "connections.list", mcp: true,
    input: z.object({ provider: z.enum(INTEGRATION_PROVIDERS).optional().describe("Only this provider. Omit for all.") }),
    providerOf: (input) => input.provider,
    description: "The workspace's connections (GitHub, Slack, Linear, Fireflies, Granola, Claude Code): whether each is connected, what it brings in, which routine triggers and abilities it unlocks, how to connect it, and what you may do with it. `actions` lists each verb you may call with the fields it takes. For Slack, `channels` lists the channels the bot has joined. Start here to learn what to pass to connections.read and connections.post.",
    handler: async ({ caller, input }) => {
      const granted = grantedProviders(caller, "connections.list");
      const all = await listIntegrations(client, caller.workspaceId, actingUserId(caller));
      const visible = all.filter((item) => (!input.provider || item.provider === input.provider) && (caller.origin.kind === "person" || granted.has(item.provider)));
      const connections = await Promise.all(visible.map(async (item) => {
        const actions = actionsFor(caller, item.provider);
        if (item.provider !== "slack" || item.status !== "connected") return { ...item, actions };
        try {
          const result = await slack.listChannels(caller.workspaceId);
          return result.ok ? { ...item, actions, channels: result.channels } : { ...item, actions, channelsError: result.error };
        } catch {
          return { ...item, actions, channelsError: "Could not list Slack channels. Try again shortly." };
        }
      }));
      return { status: "ok", output: { connections } };
    },
  });

  const connect = defineTool({
    name: "connections.connect", mcp: true, allowedOrigins: ["person"],
    input: z.object({
      provider: z.enum(INTEGRATION_PROVIDERS),
      channels: z.array(z.string().min(1)).max(100).optional().describe("Slack only, once it is connected: the public channels (ids or #names) the bot should be in. They replace the current set."),
    }),
    description: "Start connecting a provider. Answers with a link for the person to open: they sign in or enter the key there, so it never passes through you. Ask them before calling. Call connections.list afterwards to see when it is connected. If the provider is already connected it says so and gives no link. For Slack, pass channels to change which channels the bot joins.",
    auditArguments: (input) => ({ provider: input.provider, ...(input.channels ? { channelCount: input.channels.length } : {}) }),
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "connections.connect");
      if (input.channels !== undefined) {
        if (input.provider !== "slack") return refuse("channels_not_supported", `${input.provider} has no channels to set. Only Slack does.`);
        const state = (await listIntegrations(client, user.workspaceId, user.userId)).find((item) => item.provider === "slack");
        if (state?.status !== "connected") return refuse("not_connected", "Slack is not connected yet. Call connections.connect without channels to get a link, then set its channels.");
        const resolved = await resolveChannels(client, user.workspaceId, input.channels);
        if (!resolved.ok) return refuse(resolved.code, resolved.message);
        const result = await setChannels(client, user.workspaceId, resolved.channelIds);
        if (!result.ok) {
          return refuse(result.code, result.status === 409 ? "The Slack connection changed at the same time. Try again." : "Could not update the Slack channels. Try again shortly.");
        }
        const failed = result.failed.length ? ` ${result.failed.length} could not be ${result.failed.map((failure) => failure.operation === "join" ? "joined" : "left").join(" or ")}.` : "";
        return {
          status: "ok",
          output: {
            status: "connected",
            provider: "slack",
            message: `Slack is already connected. Channels updated: ${result.joined.length} joined, ${result.left.length} left.${failed}`,
            channels: { ids: result.channelIds, joined: result.joined, left: result.left, failed: result.failed },
          },
          summary: `Updated Slack channels: ${result.joined.length} joined, ${result.left.length} left`,
        };
      }
      const result = await createConnectRequest(client, { workspaceId: user.workspaceId, userId: user.userId, provider: input.provider, via: user.via === "cli" || user.via === "mcp" ? user.via : "http" });
      if (result.status === "too_many_requests") return refuse("too_many_requests", "Too many open connect links. Let the open ones expire (15 minutes) and try again.");
      return { status: "ok", output: result };
    },
  });

  const disconnect = defineTool({
    name: "connections.disconnect", mcp: true, allowedOrigins: ["person"], destructive: true,
    input: z.object({
      provider: z.enum(INTEGRATION_PROVIDERS),
      accountKind: z.enum(["personal", "workspace"]).optional().describe("Granola only: which account to disconnect. Defaults to personal."),
      confirm: z.literal(true).optional().describe("Pass true to disconnect. Without it the call only reports what would stop."),
    }),
    description: "Disconnect a provider you connected. Call once without confirm to see what would stop, show that to the person, then call again with confirm: true. Only the person who connected it can disconnect it.",
    auditArguments: (input) => ({ provider: input.provider, accountKind: input.accountKind ?? null, confirm: input.confirm === true }),
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "connections.disconnect");
      if (input.provider === "claude_session") return refuse("not_supported", "Claude Code sessions are not disconnected through Draft.");
      if (input.accountKind && input.provider !== "granola") return refuse("invalid_account_kind", "accountKind applies to Granola only.");

      const current = (await listIntegrations(client, user.workspaceId, user.userId)).find((item) => item.provider === input.provider);
      if (!current || current.status === "not_connected") {
        return { status: "ok", output: { status: "not_connected", provider: input.provider, message: `${current?.label ?? input.provider} is not connected.` } };
      }
      if (input.confirm !== true) {
        const stops = {
          ingests: current.ingests,
          triggers: current.triggers.map((trigger) => trigger.label),
          abilities: current.abilities,
        };
        return {
          status: "ok",
          output: {
            status: "confirmation_required",
            provider: input.provider,
            connectedByYou: current.connectedByYou,
            stops,
            message: `Disconnecting ${current.label} stops new items from coming in, and any routine that uses it stops working. Facts already in company context stay. To go ahead, call connections.disconnect again with {"provider":"${input.provider}","confirm":true}.`,
          },
          summary: "Asked to confirm",
        };
      }

      const result = await disconnectConnection(client, {
        workspaceId: user.workspaceId,
        userId: user.userId,
        provider: input.provider as ConnectionProvider,
        accountKind: input.provider === "granola" ? (input.accountKind ?? "personal") : null,
      });
      if (!result.ok) throw new Error(`disconnect_failed: ${describeError(result.error)}`);
      if (result.outcome === "not_owner") return refuse("not_connection_owner", `Only the person who connected ${current.label} can disconnect it.`);
      if (result.outcome === "not_found") return { status: "ok", output: { status: "not_connected", provider: input.provider, message: `${current.label} is not connected.` } };
      return { status: "ok", output: { status: "disconnected", provider: input.provider, message: `${current.label} is disconnected.` }, summary: `Disconnected ${current.label}` };
    },
  });

  const read = defineTool({
    name: "connections.read", mcp: true,
    input: z.object({
      provider: z.enum(INTEGRATION_PROVIDERS),
      channel: z.string().min(1).describe("Slack: a channel id or #name the bot has joined. connections.list shows them."),
      limit: z.number().int().min(1).max(50).optional().describe("Slack: how many recent messages, up to 50. Default 20."),
    }),
    providerOf: (input) => input.provider,
    description: "Read recent messages from a connected provider. Providers that support it: slack. Call connections.list first to see what is connected and which channels the bot has joined. Read before posting and do not repeat a message already sent.",
    auditArguments: (input) => ({ provider: input.provider, channel: input.channel, limit: input.limit ?? null }),
    handler: async ({ caller, input }) => input.provider === "slack"
      ? slack.read(caller, input)
      : refuse("unsupported_action", `${input.provider} does not support read. Providers that do: ${providersThatRead()}.`),
  });

  const post = defineTool({
    name: "connections.post", mcp: true,
    input: z.object({
      provider: z.enum(INTEGRATION_PROVIDERS),
      channel: z.string().min(1).describe("Slack: a channel id or #name the bot has joined. connections.list shows them."),
      text: z.string().min(1).max(4000).describe("The message to post."),
    }),
    providerOf: (input) => input.provider,
    description: "Post a message through a connected provider. Providers that support it: slack. Call connections.list first to see which channels the bot has joined. Read recent messages with connections.read first and do not repeat a message already sent. Draft adds an attribution line automatically.",
    auditArguments: (input) => ({ provider: input.provider, channel: input.channel, textBytes: Buffer.byteLength(input.text, "utf8") }),
    handler: async ({ caller, input }) => input.provider === "slack"
      ? slack.post(caller, input)
      : refuse("unsupported_action", `${input.provider} does not support post. Providers that do: ${providersThatPost()}.`),
  });

  return [list, connect, disconnect, read, post];
}
