import {
  joinPublicSlackChannels,
  leavePublicSlackChannels,
} from "draft-core/integrations/slack-hosted";

export {
  joinPublicSlackChannels,
  leavePublicSlackChannels,
  listPublicSlackChannels,
  SlackProviderError,
} from "draft-core/integrations/slack-hosted";
export type {
  SlackChannel,
  SlackProviderErrorCode,
} from "draft-core/integrations/slack-hosted";

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

function unique(values: string[]): string[] {
  return [...new Set(values)];
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
      await joinPublicSlackChannels(botToken, [channelId], fetchFn);
      converged.add(channelId);
      joined.push(channelId);
    } catch {
      failed.push({ channelId, operation: "join", code: "slack_channel_join_failed" });
    }
  }

  for (const channelId of current) {
    if (desiredSet.has(channelId)) continue;
    try {
      await leavePublicSlackChannels(botToken, [channelId], fetchFn);
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
