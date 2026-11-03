export type GetStartedMedia =
  | { kind: "image"; src: string; alt: string; width: number; height: number }
  | {
      kind: "video";
      mp4: string;
      webm?: string;
      poster: string;
      alt: string;
      width: number;
      height: number;
    };

export type GetStartedContent = {
  source: string;
  title: string;
  heading: string;
  lede: string;
  media: GetStartedMedia;
  caption: string;
  problemHeading: string;
  problemBody: string;
  whatHeading: string;
  rows: { title: string; body: string; soon?: boolean }[];
  agentsLine: string;
  closingHeading: string;
};

export const DEFAULT_CONTENT: GetStartedContent = {
  source: "getstarted",
  title: "Get started with Draft",
  heading: "One brain for every agent your team uses.",
  lede: "Draft keeps your company's decisions, customer context, and priorities current. Every AI agent can read them.",
  media: {
    kind: "image",
    src: "/agent-loading-action-items.gif",
    alt: "Draft preparing action items from company context",
    width: 1472,
    height: 1080,
  },
  caption: "One company brain. Every agent in sync.",
  problemHeading: "Your agents start every session knowing nothing about your company.",
  problemBody:
    "Decisions live in Slack threads, call notes, and old tickets. Each agent has to be told again, and each teammate tells it something different.",
  whatHeading: "What Draft does",
  rows: [
    {
      title: "A shared company brain",
      body: "Pulls context from Slack, GitHub, Linear, GMail, meetings, and more. Keeps it current as your team works.",
    },
    {
      title: "Routines on any agent",
      body: "Schedule recurring jobs, like a daily summary of your team's action items, and run them with the agent you prefer.",
    },
    {
      title: "Shared coding sessions",
      body: "Work in the same session as a teammate, with any agent (Claude Code, Codex, and more) you like.",
      soon: true,
    },
  ],
  agentsLine: "Works with Claude Code, Codex, Cursor, and more, through MCP or CLI.",
  closingHeading: "Give every agent the same brain.",
};

// TODO: replace the copy and the media with the final multiplayer-coding version
export const MULTIPLAYER_CODING_CONTENT: GetStartedContent = {
  ...DEFAULT_CONTENT,
  source: "getstarted-multiplayer-coding",
  title: "Code with your team in one agent session",
};
