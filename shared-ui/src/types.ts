import type { TrackFn } from "./analytics/events";

export type IntegrationStatus = "disconnected" | "pending" | "connected" | "degraded" | "error";

export interface IntegrationDetail {
  connected: boolean;
  status: IntegrationStatus;
  channelIds?: string[];
}

export interface SlackChannelOption {
  id: string;
  name: string;
  memberCount: number;
  isMember: boolean;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface SlackChannelsResult extends ActionResult {
  channels?: SlackChannelOption[];
}

export interface SlackMembershipResult {
  ok: boolean;
  channelIds: string[];
  failed: Array<{ channelId: string; operation: "join" | "leave" }>;
  error?: string;
}

export interface WebhookConnectionResult extends ActionResult {
  webhookUrl?: string;
  webhookSecret?: string;
}

export type GithubInstallPhase = "idle" | "awaiting_approval" | "connected" | "error";

export interface IntegrationActions {
  track: TrackFn;
  openUrl: (url: string) => void | Promise<void>;
  getSlackManifestUrl: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  listSlackChannels: (input: { botToken?: string }) => Promise<SlackChannelsResult>;
  connectSlack: (input: { botToken: string; appToken: string; channelIds: string[] }) => Promise<ActionResult>;
  updateSlackChannels: (input: { channelIds: string[] }) => Promise<SlackMembershipResult>;
  connectFireflies: (input: { apiKey: string }) => Promise<WebhookConnectionResult>;
  connectGranola: (input: { apiKey: string; accountKind: "personal" | "workspace" }) => Promise<ActionResult>;
  connectLinear: (input: { apiKey: string }) => Promise<ActionResult>;
  connectSessionTracking: () => Promise<ActionResult>;
  selectSessionRepoFolder: () => Promise<{ folderPath?: string }>;
  enableSessionCaptureForRepo: (input: { folderPath: string }) => Promise<ActionResult>;
}

/** One repo with session capture on, from GET /workspaces/:id/sessions/projects. */
export interface TeamSessionRepo {
  id: string;
  label: string | null;
  created_at: string;
  created_by: { user_id: string; display: string; is_me: boolean } | null;
  last_upload_at: string | null;
  session_count: number;
  contributors: Array<{ display: string; is_me: boolean; verified: boolean }>;
}

export type TeamSessionReposState =
  | { status: "loading" | "error"; repos: TeamSessionRepo[] }
  | { status: "ready"; repos: TeamSessionRepo[] };
