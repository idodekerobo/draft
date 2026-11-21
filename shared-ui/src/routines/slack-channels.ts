export interface SlackChannelOption {
  id: string;
  name: string;
}

/** The answer of a connections.list call for the slack provider, as the tools route returns it. */
export interface ConnectionsListAnswer {
  status: string;
  message?: string;
  output?: { connections?: Array<{ status?: string; channels?: SlackChannelOption[]; channelsError?: string }> };
}

/** The channels the Slack bot has joined, or an error that says why they could not be listed. */
export function slackChannelsFromConnections(answer: ConnectionsListAnswer): SlackChannelOption[] {
  const slack = answer.output?.connections?.[0];
  if (answer.status !== "ok" || !slack) throw new Error(answer.message ?? "Could not load Slack channels.");
  if (slack.channelsError) throw new Error(slack.channelsError);
  if (!slack.channels) throw new Error("Slack is not connected for this workspace.");
  return slack.channels;
}
