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
  primaryCta: "call" | "waitlist" | "download";
  callLabel: string;
  waitlistLabel: string;
  downloadLabel?: string;
  downloadHref?: string;
  downloadNote?: string;
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
  primaryCta: "call",
  callLabel: "Book a call",
  waitlistLabel: "Not ready? Leave your email",
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

export const MULTIPLAYER_CODING_CONTENT: GetStartedContent = {
  ...DEFAULT_CONTENT,
  source: "getstarted-multiplayer-coding",
  primaryCta: "download",
  callLabel: "Have Questions? Book a Call",
  waitlistLabel: "Join the waitlist for updates",
  downloadLabel: "Download Early Access",
  downloadHref: "https://github.com/idodekerobo/draft/releases/latest/download/stable-macos-arm64-Draft.dmg",
  downloadNote: "Mac with Apple Silicon (M1 or later).",
  title: "Multiplayer Coding Sessions with Draft",
  heading: "Code with your whole team in one agent session.",
  lede: "Invite a teammate into your Claude Code or Codex session. You both prompt the same agent and see the same work. Draft saves what you decide to your company brain.",
  caption: "Two teammates. One session. Saved to your company brain.",
  problemHeading: "AI coding is a solo sport today.",
  problemBody:
    "Each person talks to their own agent in their own window. Ideas get lost between chats. The decisions never reach the rest of the team.",
  whatHeading: "How multiplayer sessions work",
  rows: [
    {
      title: "Start a session and invite a teammate",
      body: "Open a session with the agent you prefer (Claude Code, Codex, and more). Share it. Your teammate joins the same conversation.",
    },
    {
      title: "Work in it together",
      body: "You both prompt the same agent and see every reply. Brainstorm, plan, or build as a team.",
    },
    {
      title: "It syncs to your context",
      body: "Draft reads the session as you work. Decisions, open questions, and next steps flow into your company brain. You write no notes and copy nothing by hand.",
    },
  ],
  closingHeading: "Stop coding alone. Give your team one session and one brain.",
  media: {
    kind: "video",
    mp4: "/multiplayer-coding-demo.mp4",
    poster: "/multiplayer-coding-demo-poster.jpg",
    alt: "Two teammates brainstorming with Claude Code in the same Draft session",
    width: 1104,
    height: 720,
  },
};
