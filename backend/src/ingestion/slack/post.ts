/** The few Slack Web API calls Draft makes to message a person. One client, shared by every Slack sender. */

interface SlackEnvelope {
  ok?: boolean;
  error?: string;
  channel?: { id?: string };
}

export class SlackSendError extends Error {
  constructor(public readonly slackError: string) {
    super(`slack_send_failed: ${slackError}`);
    this.name = "SlackSendError";
  }
}

async function slackPost(botToken: string, method: string, body: Record<string, unknown>, fetchFn: typeof fetch): Promise<SlackEnvelope> {
  const response = await fetchFn(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new SlackSendError(`http_${response.status}`);
  const envelope = (await response.json()) as SlackEnvelope;
  if (!envelope.ok) throw new SlackSendError(envelope.error ?? "unknown");
  return envelope;
}

/** Opens (or finds) the direct message channel between the bot and one Slack member. */
export async function openSlackDm(botToken: string, slackUserId: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const envelope = await slackPost(botToken, "conversations.open", { users: slackUserId }, fetchFn);
  const channel = envelope.channel?.id;
  if (!channel) throw new SlackSendError("no_channel");
  return channel;
}

export async function postSlackMessage(botToken: string, channel: string, text: string, fetchFn: typeof fetch = fetch): Promise<void> {
  // Links are not expanded and names are not turned into mentions: the text is written by an agent.
  await slackPost(botToken, "chat.postMessage", { channel, text, unfurl_links: false, unfurl_media: false, link_names: false }, fetchFn);
}
