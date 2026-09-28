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
  track: (event: string, properties: Record<string, unknown>) => void;
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

export interface HeadlessSetupActions {
  getAvailableRunners: () => Promise<{ runners: Array<{ name: "claude" | "codex"; installed: boolean }> }>;
  subscribeToProgress: (listener: (progress: { phase: "starting" | "running" | "writing" | "complete" | "error"; label: string; error?: string }) => void) => () => void;
  getContextFiles: () => Promise<Array<{ label: string }>>;
  selectSetupFolder: () => Promise<{ folderPath?: string }>;
  runHeadlessSetup: (input: { mode: "import" | "github"; runner: "claude" | "codex"; dimensions: string[]; folderPath?: string; githubUrl?: string }) => Promise<ActionResult>;
  openWorkspaceInFinder: () => void | Promise<void>;
}
