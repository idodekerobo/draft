import manifestJson from "../../../background/integrations/slack/manifest.json";

export interface SlackManifest {
  display_information: Record<string, unknown>;
  features: Record<string, unknown>;
  oauth_config: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export const slackManifest = manifestJson as SlackManifest;
export const SLACK_MANIFEST = slackManifest;

export type SlackManifestResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export function buildSlackManifestUrl(): SlackManifestResult {
  return {
    ok: true,
    url: `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(slackManifest))}`,
  };
}

export type SlackFormatResult =
  | { ok: true }
  | { ok: false; error: string };

export function validateSlackTokenFormat(botToken: string, appToken: string): SlackFormatResult {
  if (!botToken.startsWith("xoxb-")) return { ok: false, error: "Bot tokens start with xoxb-." };
  if (!appToken.startsWith("xapp-")) return { ok: false, error: "App tokens start with xapp-." };
  return { ok: true };
}

export interface SlackChannel {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
}

export type SlackConversationTypes = "public_channel" | "public_channel,private_channel";

export type SlackProviderErrorCode =
  | "slack_channel_list_failed"
  | "slack_channel_join_failed"
  | "slack_channel_leave_failed";

export class SlackProviderError extends Error {
  constructor(public readonly code: SlackProviderErrorCode) {
    super(code);
    this.name = "SlackProviderError";
  }
}

export type SlackChannelResult =
  | { ok: true; channels: SlackChannel[] }
  | { ok: false; error: string };

interface SlackEnvelope {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

const MAX_SLACK_CHANNEL_PAGES = 1_000;

async function slackRequest(
  url: string,
  init: RequestInit,
  errorCode: SlackProviderErrorCode,
  fetchFn: typeof fetch,
): Promise<SlackEnvelope> {
  try {
    const response = await fetchFn(url, init);
    if (!response.ok) throw new SlackProviderError(errorCode);
    const payload = await response.json() as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SlackProviderError(errorCode);
    }
    const envelope = payload as Partial<SlackEnvelope>;
    if (typeof envelope.ok !== "boolean") throw new SlackProviderError(errorCode);
    if (envelope.error !== undefined && typeof envelope.error !== "string") {
      throw new SlackProviderError(errorCode);
    }
    return envelope as SlackEnvelope;
  } catch (error) {
    if (error instanceof SlackProviderError) throw error;
    throw new SlackProviderError(errorCode);
  }
}

function parseChannelPage(data: SlackEnvelope): { channels: SlackChannel[]; cursor: string } {
  if (!data.ok || (data.channels !== undefined && !Array.isArray(data.channels))) {
    throw new SlackProviderError("slack_channel_list_failed");
  }
  const channels = (data.channels ?? []).map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SlackProviderError("slack_channel_list_failed");
    }
    const channel = raw as Record<string, unknown>;
    if (
      typeof channel.id !== "string" || channel.id.length === 0 ||
      typeof channel.name !== "string" || channel.name.length === 0 ||
      (channel.num_members !== undefined && (
        typeof channel.num_members !== "number" ||
        !Number.isFinite(channel.num_members) ||
        channel.num_members < 0
      )) ||
      (channel.is_member !== undefined && typeof channel.is_member !== "boolean")
    ) {
      throw new SlackProviderError("slack_channel_list_failed");
    }
    return {
      id: channel.id,
      name: channel.name,
      memberCount: channel.num_members ?? 0,
      isMember: channel.is_member ?? false,
    };
  });

  if (
    data.response_metadata !== undefined &&
    (!data.response_metadata || typeof data.response_metadata !== "object" || Array.isArray(data.response_metadata))
  ) {
    throw new SlackProviderError("slack_channel_list_failed");
  }
  const cursor = (data.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
  if (cursor !== undefined && typeof cursor !== "string") {
    throw new SlackProviderError("slack_channel_list_failed");
  }
  return { channels, cursor: cursor ?? "" };
}

export async function walkSlackChannelPages(
  botToken: string,
  types: SlackConversationTypes,
  fetchFn: typeof fetch = fetch,
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";

  for (let page = 1; page <= MAX_SLACK_CHANNEL_PAGES; page++) {
    const query = new URLSearchParams({ types, limit: "200", exclude_archived: "true" });
    if (cursor) query.set("cursor", cursor);
    const data = await slackRequest(
      `https://slack.com/api/conversations.list?${query.toString()}`,
      { headers: { Authorization: `Bearer ${botToken}` } },
      "slack_channel_list_failed",
      fetchFn,
    );
    const parsed = parseChannelPage(data);
    channels.push(...parsed.channels);
    if (!parsed.cursor) return channels;
    if (parsed.cursor === cursor || seenCursors.has(parsed.cursor)) {
      throw new SlackProviderError("slack_channel_list_failed");
    }
    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }

  throw new SlackProviderError("slack_channel_list_failed");
}

export async function listSlackChannels(
  botToken: string,
  types: SlackConversationTypes = "public_channel,private_channel",
  fetchFn: typeof fetch = fetch,
): Promise<SlackChannel[]> {
  const channels = await walkSlackChannelPages(botToken, types, fetchFn);
  return channels.sort((a, b) => b.memberCount - a.memberCount);
}

export function listPublicSlackChannels(
  botToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<SlackChannel[]> {
  return listSlackChannels(botToken, "public_channel", fetchFn);
}

export async function fetchSlackChannels(
  botToken: string,
  types: SlackConversationTypes = "public_channel,private_channel",
  fetchFn: typeof fetch = fetch,
): Promise<SlackChannelResult> {
  try {
    return { ok: true, channels: await listSlackChannels(botToken, types, fetchFn) };
  } catch {
    return { ok: false, error: "Could not fetch Slack channels." };
  }
}

async function changeSlackMembership(
  botToken: string,
  channelId: string,
  operation: "join" | "leave",
  fetchFn: typeof fetch,
): Promise<void> {
  const errorCode = operation === "join"
    ? "slack_channel_join_failed"
    : "slack_channel_leave_failed";
  const data = await slackRequest(
    `https://slack.com/api/conversations.${operation}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ channel: channelId }),
    },
    errorCode,
    fetchFn,
  );
  const converged = operation === "join"
    ? data.error === "already_in_channel"
    : data.error === "not_in_channel";
  if (!data.ok && !converged) throw new SlackProviderError(errorCode);
}

export async function joinPublicSlackChannels(
  botToken: string,
  channelIds: string[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  for (const channelId of channelIds) {
    await changeSlackMembership(botToken, channelId, "join", fetchFn);
  }
}

export async function leavePublicSlackChannels(
  botToken: string,
  channelIds: string[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  for (const channelId of channelIds) {
    await changeSlackMembership(botToken, channelId, "leave", fetchFn);
  }
}
