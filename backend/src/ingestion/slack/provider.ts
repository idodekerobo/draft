export interface SlackChannel {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
}

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

export interface SlackReconcileFailure {
  channelId: string;
  operation: "join" | "leave";
  code: "slack_channel_join_failed" | "slack_channel_leave_failed";
}

export interface SlackReconcileResult {
  channelIds: string[];
  joined: string[];
  left: string[];
  failed: SlackReconcileFailure[];
}

interface SlackEnvelope {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

const MAX_SLACK_CHANNEL_PAGES = 1_000;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function slackRequest(
  url: string,
  init: RequestInit,
  errorCode: SlackProviderErrorCode,
  fetchFn: typeof fetch,
): Promise<SlackEnvelope> {
  try {
    const response = await fetchFn(url, init);
    const payload = await response.json() as unknown;
    if (!response.ok || !payload || typeof payload !== "object") {
      throw new SlackProviderError(errorCode);
    }
    const envelope = payload as Partial<SlackEnvelope>;
    if (typeof envelope.ok !== "boolean") throw new SlackProviderError(errorCode);
    return envelope as SlackEnvelope;
  } catch (error) {
    if (error instanceof SlackProviderError) throw error;
    throw new SlackProviderError(errorCode);
  }
}

export async function listPublicSlackChannels(
  botToken: string,
  fetchFn: typeof fetch = fetch,
): Promise<SlackChannel[]> {
  const channels: SlackChannel[] = [];
  const seenCursors = new Set<string>();
  let cursor = "";
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > MAX_SLACK_CHANNEL_PAGES || (cursor && seenCursors.has(cursor))) {
      throw new SlackProviderError("slack_channel_list_failed");
    }
    if (cursor) seenCursors.add(cursor);

    const query = new URLSearchParams({
      types: "public_channel",
      limit: "200",
      exclude_archived: "true",
    });
    if (cursor) query.set("cursor", cursor);

    const data = await slackRequest(
      `https://slack.com/api/conversations.list?${query.toString()}`,
      { headers: { Authorization: `Bearer ${botToken}` } },
      "slack_channel_list_failed",
      fetchFn,
    );
    if (!data.ok) throw new SlackProviderError("slack_channel_list_failed");

    const page = data.channels;
    if (page !== undefined && !Array.isArray(page)) {
      throw new SlackProviderError("slack_channel_list_failed");
    }
    for (const raw of page ?? []) {
      if (!raw || typeof raw !== "object") {
        throw new SlackProviderError("slack_channel_list_failed");
      }
      const channel = raw as Record<string, unknown>;
      if (typeof channel.id !== "string" || typeof channel.name !== "string") {
        throw new SlackProviderError("slack_channel_list_failed");
      }
      channels.push({
        id: channel.id,
        name: channel.name,
        memberCount: typeof channel.num_members === "number" ? channel.num_members : 0,
        isMember: channel.is_member === true,
      });
    }

    const metadata = data.response_metadata;
    if (metadata !== undefined && (!metadata || typeof metadata !== "object")) {
      throw new SlackProviderError("slack_channel_list_failed");
    }
    const nextCursor = (metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (nextCursor !== undefined && typeof nextCursor !== "string") {
      throw new SlackProviderError("slack_channel_list_failed");
    }
    if (nextCursor && (nextCursor === cursor || seenCursors.has(nextCursor))) {
      throw new SlackProviderError("slack_channel_list_failed");
    }
    cursor = nextCursor ?? "";
  } while (cursor);

  return channels.sort((a, b) => b.memberCount - a.memberCount);
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

  const alreadyConverged = operation === "join"
    ? data.error === "already_in_channel"
    : data.error === "not_in_channel";
  if (!data.ok && !alreadyConverged) throw new SlackProviderError(errorCode);
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

export async function reconcileSlackChannels(
  botToken: string,
  currentChannelIds: string[],
  desiredChannelIds: string[],
  fetchFn: typeof fetch = fetch,
): Promise<SlackReconcileResult> {
  const current = unique(currentChannelIds);
  const desired = unique(desiredChannelIds);
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  const converged = new Set(current);
  const joined: string[] = [];
  const left: string[] = [];
  const failed: SlackReconcileFailure[] = [];

  for (const channelId of desired) {
    if (currentSet.has(channelId)) continue;
    try {
      await changeSlackMembership(botToken, channelId, "join", fetchFn);
      converged.add(channelId);
      joined.push(channelId);
    } catch {
      failed.push({ channelId, operation: "join", code: "slack_channel_join_failed" });
    }
  }

  for (const channelId of current) {
    if (desiredSet.has(channelId)) continue;
    try {
      await changeSlackMembership(botToken, channelId, "leave", fetchFn);
      converged.delete(channelId);
      left.push(channelId);
    } catch {
      failed.push({ channelId, operation: "leave", code: "slack_channel_leave_failed" });
    }
  }

  return {
    channelIds: [
      ...desired.filter((channelId) => converged.has(channelId)),
      ...current.filter((channelId) => !desiredSet.has(channelId) && converged.has(channelId)),
    ],
    joined,
    left,
    failed,
  };
}
