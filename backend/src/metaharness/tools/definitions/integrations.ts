import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolCaller } from "draft-core/tools";
import { describeError } from "../../../errors/describe-error";
import { disconnectConnection } from "../../../integrations/disconnect";
import { INTEGRATION_PROVIDERS, createConnectRequest, listIntegrations, type IntegrationProvider } from "../../../integrations/service";
import { resolveSlackChannelEntries, updateSlackChannelMembership } from "../../../integrations/slack-channels";
import type { ConnectionProvider } from "../../../types/enums";
import { defineTool, refuse, type ToolHandlerResult } from "../tool-registry";
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
    { verb: "join", description: "Have the bot join public channels. It changes only the channels you name. Call connections.list with available: true to see which exist.", fields: { channels: "channel ids or #names to join (required)" }, personOnly: true },
    { verb: "leave", description: "Have the bot leave public channels. It changes only the channels you name.", fields: { channels: "channel ids or #names to leave (required)" }, personOnly: true },
  ],
};

const VERB_TOOL = { read: "connections.read", post: "connections.post" } as const;
const providersWithChannels = (): string => Object.entries(PROVIDER_ACTIONS).filter(([, actions]) => actions?.some((action) => action.verb === "join")).map(([provider]) => provider).join(", ");
const SLACK_NOT_CONNECTED = "Slack is not connected for this workspace. A person can connect it with connections.connect.";
const providersThatRead = (): string => Object.entries(PROVIDER_ACTIONS).filter(([, actions]) => actions?.some((action) => action.verb === "read")).map(([provider]) => provider).join(", ");
const providersThatPost = (): string => Object.entries(PROVIDER_ACTIONS).filter(([, actions]) => actions?.some((action) => action.verb === "post")).map(([provider]) => provider).join(", ");

export interface IntegrationToolDeps {
  slack?: SlackDeps;
  /** Tests pass their own. The defaults talk to Slack and the database. */
  slackChannels?: { resolve: typeof resolveSlackChannelEntries; update: typeof updateSlackChannelMembership };
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
  const updateChannels = deps.slackChannels?.update ?? updateSlackChannelMembership;

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
    input: z.object({
      provider: z.enum(INTEGRATION_PROVIDERS).optional().describe("Only this provider. Omit for all."),
      available: z.boolean().optional().describe("Slack only, with provider: also list every public channel, whether or not the bot has joined it, biggest first. People only."),
      query: z.string().min(1).optional().describe("With available: only channels whose name contains this."),
      limit: z.number().int().min(1).max(100).optional().describe("With available: how many channels to return, up to 100. Default 50."),
      cursor: z.string().min(1).optional().describe("With available: the nextCursor of the previous page."),
    }),
    providerOf: (input) => input.provider,
    description: "The workspace's connections (GitHub, Slack, Linear, Fireflies, Granola, Claude Code): whether each is connected, what it brings in, which routine triggers and abilities it unlocks, how to connect it, and what you may do with it. `actions` lists each verb you may call with the fields it takes. For Slack, `channels` lists the channels the bot has joined. To see every public channel, pass provider \"slack\" and available: true: each channel has id, name, memberCount and joined, biggest first, and `nextCursor` (pass it as cursor for the next page) is null on the last page. Add query to search by name. Then connections.join, connections.read and connections.post take an id or #name.",
    handler: async ({ caller, input }) => {
      const browsing = input.available === true;
      if (!browsing && (input.query !== undefined || input.limit !== undefined || input.cursor !== undefined)) {
        return refuse("available_required", "query, limit and cursor go with available: true.");
      }
      if (browsing) {
        if (caller.origin.kind !== "person") return refuse("not_allowed", "Listing every channel is for people. Without available, connections.list shows the channels the bot has joined.");
        if (!input.provider) return refuse("provider_required", "available needs a provider. Pass provider: \"slack\".");
        if (input.provider !== "slack") return refuse("unsupported_action", `${input.provider} has no channels to browse. Providers that do: ${providersWithChannels()}.`);
      }

      const granted = grantedProviders(caller, "connections.list");
      const all = await listIntegrations(client, caller.workspaceId, actingUserId(caller));
      const visible = all.filter((item) => (!input.provider || item.provider === input.provider) && (caller.origin.kind === "person" || granted.has(item.provider)));
      let badCursor: ToolHandlerResult | null = null;
      const connections = await Promise.all(visible.map(async (item) => {
        const actions = actionsFor(caller, item.provider);
        if (item.provider !== "slack") return { ...item, actions };
        if (item.status !== "connected") return browsing ? { ...item, actions, availableError: SLACK_NOT_CONNECTED } : { ...item, actions };
        const joined = await slack.listChannels(caller.workspaceId).then(
          (result) => (result.ok ? { channels: result.channels } : { channelsError: result.error }),
          () => ({ channelsError: "Could not list Slack channels. Try again shortly." }),
        );
        if (!browsing) return { ...item, actions, ...joined };
        const page = await slack.browseChannels(caller.workspaceId, { query: input.query, limit: input.limit ?? 50, cursor: input.cursor }).catch(
          (): { ok: false; code: string; error: string } => ({ ok: false, code: "slack_unavailable", error: "Could not list Slack channels. Try again shortly." }),
        );
        if (page.ok) return { ...item, actions, ...joined, available: { channels: page.channels, nextCursor: page.nextCursor } };
        if (page.code === "invalid_cursor") badCursor = refuse(page.code, page.error);
        return { ...item, actions, ...joined, availableError: page.error };
      }));
      if (badCursor) return badCursor;
      return { status: "ok", output: { connections } };
    },
  });

  const connect = defineTool({
    name: "connections.connect", mcp: true, allowedOrigins: ["person"],
    input: z.object({ provider: z.enum(INTEGRATION_PROVIDERS) }),
    description: "Start connecting a provider. Answers with a link for the person to open: they sign in or enter the key there, so it never passes through you. Ask them before calling. Call connections.list afterwards to see when it is connected. If the provider is already connected it says so and gives no link. For Slack, once it is connected, use connections.join and connections.leave to choose its channels.",
    handler: async ({ caller, input }) => {
      const user = requireUser(caller, "connections.connect");
      const result = await createConnectRequest(client, { workspaceId: user.workspaceId, userId: user.userId, provider: input.provider, via: user.via === "cli" || user.via === "mcp" ? user.via : "http" });
      if (result.status === "too_many_requests") return refuse("too_many_requests", "Too many open connect links. Let the open ones expire (15 minutes) and try again.");
      return { status: "ok", output: result };
    },
  });

  /** Joins or leaves only the channels named, and says which changed, which were already so, and which failed. */
  async function changeChannels(caller: ToolCaller, input: { provider: IntegrationProvider; channels: string[] }, verb: "join" | "leave"): Promise<ToolHandlerResult> {
    const user = requireUser(caller, `connections.${verb}`);
    if (input.provider !== "slack") return refuse("unsupported_action", `${input.provider} has no channels to ${verb}. Providers that do: ${providersWithChannels()}.`);
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

  const channelsField = z.array(z.string().min(1)).min(1).max(100).describe("Slack channel ids or #names. connections.list with available: true shows the ids.");
  const join = defineTool({
    name: "connections.join", mcp: true, allowedOrigins: ["person"],
    input: z.object({ provider: z.enum(INTEGRATION_PROVIDERS), channels: channelsField }),
    description: "Have a connected provider join channels: Slack's bot joins public channels, so Draft reads them and a routine can post in them. It changes only the channels you name, and says which it joined, which it was already in, and which failed. To see every public channel, call connections.list with provider \"slack\" and available: true.",
    auditArguments: (input) => ({ provider: input.provider, channelCount: input.channels.length }),
    handler: ({ caller, input }) => changeChannels(caller, input, "join"),
  });
  const leave = defineTool({
    name: "connections.leave", mcp: true, allowedOrigins: ["person"],
    input: z.object({ provider: z.enum(INTEGRATION_PROVIDERS), channels: channelsField }),
    description: "Have a connected provider leave channels: Slack's bot leaves public channels and Draft stops reading them. Messages Draft already read stay. It changes only the channels you name, and says which it left and which it was not in.",
    auditArguments: (input) => ({ provider: input.provider, channelCount: input.channels.length }),
    handler: ({ caller, input }) => changeChannels(caller, input, "leave"),
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

  return [list, connect, disconnect, join, leave, read, post];
}
