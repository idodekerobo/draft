// desktop/src/rpc/schema.ts — typed IPC contract between Bun main process and renderer
//
// Import this file in BOTH bun (src/index.ts) and browser (src/mainview/index.ts).
// Use `import type` from "electrobun/bun" so the type is erased at runtime — the
// renderer never loads any bun-side module.
//
// Convention (matches Electrobun RPCSchema):
//   bun.requests   — renderer calls → bun responds
//   bun.messages   — renderer sends fire-and-forget → bun handles
//   webview.requests  — bun calls → renderer responds
//   webview.messages  — bun sends fire-and-forget → renderer handles

import type { RPCSchema } from "electrobun/bun";

export interface UserIdentity {
  signedIn: boolean;
  hydrated: boolean;
  organizationId: string | null;
  teamId: string | null;
  workspaceId: string | null;
  /** Server timestamp of when this user finished the onboarding wizard, or null. */
  onboardingCompletedAt: string | null;
}

// ── Shared payload types ───────────────────────────────────────────────────────
// Defined inline here (not imported from draft-core) so the renderer can safely
// import this file without pulling in any Node/Bun-only modules.

export interface WorkspaceRun {
  id: string;
  status: "queued" | "preparing" | "running" | "validating" | "committing" |
          "succeeded" | "failed" | "stale" | "cancelled";
  outcome: "changed" | "no_change" | "failure" | "stale" | null;
  triggerType: "schedule" | "source_threshold" | "manual" | "retry" | "stale_requeue" | "seed_test";
  resultSummary: string | null;
  startedAt: string | null; // ISO 8601
  completedAt: string | null;
  createdAt: string;
}

/** Coding tools that have been set up with `draft add <tool>`. */
export interface InstalledToolsStatus {
  "claude-code": boolean;
  codex: boolean;
  cursor: boolean;
  openclaw: boolean;
  hermes: boolean;
}

export interface AppStatus {
  /** First-run/setup-ready state for renderer routing and setup copy. */
  appState: AppState;
  /** Which coding tools have been set up with `draft add` — read from config.json. */
  installedTools: InstalledToolsStatus;
}

export type AppUserState =
  | "no-profile"
  | "no-context"
  | "ready-stopped"
  | "ready-running";

// ── Installer types ────────────────────────────────────────────────────────────

export type InstallableTool = "claude-code" | "codex" | "cursor" | "openclaw" | "hermes";

export interface InstallStep {
  label: string;
  ok: boolean;
  error?: string;
}

export interface InstallResult {
  ok: boolean;
  steps: InstallStep[];
}

export interface AppState {
  userState: AppUserState;
  hasActiveProfile: boolean;
  hasContextFiles: boolean;
  daemonState: "running" | "stopped" | "never-started";
  heartbeatAgeMs: number | null;
  activeProfile: string;
}

export interface SessionLaunchConfig {
  tool: "claude-code" | "codex";
  profile: string;
  workingDir?: string;
}

export interface LaunchResult {
  ok: boolean;
  pid?: number;
  error?: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface LocalConfig {
  launchOnLogin: boolean;
  notificationsEnabled: boolean;
  disabledContextSections: string[];
  codexScanIntervalMinutes: number | null;
}

export interface UpdateInfo {
  version: string;
  updateAvailable: boolean;
  updateReady: boolean;
  error?: string;
}

export interface AppVersionInfo {
  version: string;
  channel: string;
}

/** The account's analytics choice. userId is null when signed out. */
export interface PrivacyState {
  userId: string | null;
  analyticsConsent: boolean;
}

export interface AnalyticsConfig {
  consent: "pending" | "opted_in" | "opted_out";
  anonymous_id: string;
  posthog_host?: string;
  /** Runtime-only: sourced from build-config.json, never persisted to ~/.draft/config.json. */
  posthog_key?: string;
}

/** Detail for a single intelligence tool (claude-code, codex, cursor). */
export interface ToolDetail {
  installed: boolean;
  /** ISO timestamp, "migrated" for auto-detected legacy installs, or null if never installed. */
  addedAt: string | null;
}

/** Detail for a single input source integration (granola, slack, github, fireflies). */
export interface IntegrationDetail {
  connected: boolean;
  status: "disconnected" | "pending" | "connected" | "degraded" | "error";
  /** Runtime source health. Setup intent remains represented by connected. */
  healthStatus: "unknown" | "healthy" | "needs_attention";
  healthCheckedAt: string | null;
  healthMessage: string | null;
  lastConnected: string | null;
  /** "passive"|"tagged" for Slack; null otherwise. Granola and Fireflies have no mode — always null. */
  mode: string | null;
  /** Slack: number of channels in the persisted bot membership set. Null for other sources. */
  channels: number | null;
  /** Slack: persisted bot membership returned by the cloud connection status. */
  channelIds?: string[];
  /** Connected account name, for example the Slack workspace or GitHub org. */
  displayName?: string | null;
}

/**
 * One row in a multi-account provider's connection list (Settings only --
 * every other IntegrationDetail consumer keeps the folded single-row shape).
 */
export interface MultiAccountConnectionListItem {
  id: string | null;
  is_mine: boolean;
  status: "disconnected" | "pending" | "connected" | "degraded" | "error";
  connected: boolean;
  display_name: string | null;
  last_success_at: string | null;
  last_error_at: string | null;
  /** Granola only: distinguishes a caller-owned personal-key row from the workspace's single shared workspace-key row. */
  account_kind?: "personal" | "workspace";
}

export interface ConnectedAppsStatus {
  tools: {
    "claude-code": ToolDetail;
    codex: ToolDetail;
    cursor: ToolDetail;
    openclaw: ToolDetail;
    hermes: ToolDetail;
  };
  integrations: {
    granola: IntegrationDetail;
    slack: IntegrationDetail;
    github: IntegrationDetail;
    fireflies: IntegrationDetail;
    linear: IntegrationDetail;
  };
  claudeCode: { connected: boolean };
  /** The caller's latest agent (MCP or CLI) query, or null before first use. */
  agentLastUsedAt: string | null;
  /** API base URL, so the MCP endpoint shown in Connections matches this deployment. */
  apiBaseUrl: string;
  webAppUrl: string;
  /** Every Fireflies connection in the workspace (Settings list view only) -- see MultiAccountConnectionListItem. */
  firefliesConnections: MultiAccountConnectionListItem[];
  /** Every Granola connection in the workspace, personal rows plus the workspace-key row if any (Settings list view only) -- see MultiAccountConnectionListItem. */
  granolaConnections: MultiAccountConnectionListItem[];
}

/**
 * A Slack channel the bot can see, from conversations.list.
 * Mirrors draft-core/integrations/slack-hosted's SlackChannel rather than importing it,
 * per this file's convention of staying free of Node/Bun-only modules.
 */
export interface SlackChannelOption {
  id: string;
  name: string;
  memberCount: number;
  /** True if the bot is already a member — e.g. invited directly in Slack. */
  isMember: boolean;
}

export interface SlackMembershipReconcileResult {
  ok: boolean;
  channelIds: string[];
  joined: string[];
  left: string[];
  error?: string;
  failed: Array<{
    channelId: string;
    operation: "join" | "leave";
    code: "slack_channel_join_failed" | "slack_channel_leave_failed";
  }>;
}

import type { ContextFileEntry } from "draft-shared-ui/context-files";
import type { Routine, RoutinePatch, RoutinesResponse } from "draft-shared-ui";
export type { ContextFileEntry };

// ── RPC schema ─────────────────────────────────────────────────────────────────

export type AppRPCType = {
  /**
   * Bun-side handlers.
   * requests: renderer calls → bun responds (awaitable)
   * messages: renderer sends → bun handles (fire-and-forget)
   */
  bun: RPCSchema<{
    requests: {
      /** Get current app state. */
      getStatus: { params: void; response: AppStatus };

      /** Launch a terminal session for the given tool + profile. */
      launchSession: { params: SessionLaunchConfig; response: LaunchResult };

      /** Read local settings and global notification preference. */
      getLocalConfig: { params: void; response: LocalConfig };

      /** Patch local settings and global notification preference. */
      setLocalConfig: { params: Partial<LocalConfig>; response: ActionResult };

      /** List all readable context files for the active workspace. */
      getContextFiles: { params: void; response: ContextFileEntry[] };

      /** Ask for a folder, then save the full context there as a zip of markdown files. */
      exportContext: { params: void; response: { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string } };

      /** Rich connection status for all intelligence tools and input sources, plus firefliesConnections for the Settings list view. */
      getConnectedApps: { params: void; response: ConnectedAppsStatus };

      /** List the workspace's recurring routines (schedules) and whether the caller may edit them. */
      listRoutines: { params: void; response: RoutinesResponse };

      /** Toggle or re-schedule one routine. Failures carry the API error code and offending field. */
      updateRoutine: { params: { id: string; patch: RoutinePatch }; response: { ok: true; routine: Routine } | { ok: false; code: string; field?: string } };

      /** Disconnect an input source by revoking its cloud source_connections row. Granola also takes an optional accountKind (default "personal") to pick which of the caller's rows to revoke. */
      disconnectIntegration: { params: { source: "granola" | "slack" | "github" | "fireflies" | "linear"; accountKind?: "personal" | "workspace" }; response: ActionResult };

      /**
       * Connect GitHub via the GitHub App install flow: opens the system
       * browser to GitHub's install-consent screen and polls the backend
       * install session (fire-and-forget; progress arrives via the
       * githubInstallProgress webview message).
       */
      startGithubInstall: { params: void; response: ActionResult };
      cancelGithubInstall: { params: void; response: ActionResult };

      /** First-launch install: extract binary, symlink to PATH, run `draft add` for each tool. */
      runInstall: { params: { tools: InstallableTool[] }; response: InstallResult };

      /**
       * Persist a Granola API key in Draft Cloud; the server registers the
       * webhook itself (Granola exposes webhook management as an API, so
       * unlike Fireflies there's no separate paste-into-vendor-UI step or
       * webhook fields in the response). accountKind "personal" connects
       * the caller's own account (multi-account, one row per teammate);
       * "workspace" connects the workspace's single shared key.
       */
      connectGranola: { params: { apiKey: string; accountKind: "personal" | "workspace" }; response: ActionResult };

      /** Persist Fireflies API credentials in Draft Cloud and return webhook setup values. */
      connectFireflies: { params: { apiKey: string }; response: ActionResult & { webhookUrl?: string; webhookSecret?: string } };

      /** Persist a Linear personal API key in Draft Cloud; the server creates the webhook itself. */
      connectLinear: { params: { apiKey: string }; response: ActionResult };

      /** Persist a Claude Code OAuth token in Draft Cloud for the workspace's cloud sandbox to use. */
      connectClaudeCode: { params: { token: string }; response: ActionResult };

      /** Fetch (or lazily create) a reusable, multi-use invite link for the caller's own org/team. */
      getInviteLink: { params: void; response: ActionResult & { url?: string; expiresAt?: string } };

      /** Build and return the Slack app creation URL with the manifest pre-filled. */
      getSlackManifestUrl: { params: void; response: { ok: boolean; url?: string; error?: string } };

      /**
       * List public Slack channels during initial setup via conversations.list.
       * Omit botToken to ask the server to use the stored credential for the
       * Settings "Update channels" flow.
       */
      listSlackChannels: { params: { botToken?: string }; response: { ok: boolean; channels?: SlackChannelOption[]; error?: string } };

      /** Persist Slack credentials and join the selected public channels. */
      connectSlack: { params: { botToken: string; appToken: string; channelIds: string[] }; response: ActionResult };

      /** Reconcile saved Slack membership to the selected public channels. */
      updateSlackChannels: {
        params: { channelIds: string[] };
        response: SlackMembershipReconcileResult;
      };

      /** Open the native folder picker for an optional local-context import. */
      selectSetupFolder: { params: void; response: { folderPath: string | null } };

      /** Detect which CLI runners are installed. */
      getAvailableRunners: { params: void; response: { runners: Array<{ name: "claude" | "codex"; installed: boolean }> } };

      /** Check whether the active workspace already has a bootstrapped context version — used to auto-skip the cloud-bootstrap onboarding step. */
      getWorkspaceContextStatus: { params: void; response: { hasContext: boolean } };

      /** Trigger a cloud synthesis run against whatever source items are currently ready. */
      triggerSynthesisRun: { params: void; response: ActionResult & { runId?: string; machineId?: string; reason?: string } };

      /** Open the native folder picker for uploading local files as source items for the cloud sandbox to read. */
      selectUploadFolder: { params: void; response: { folderPath: string | null } };

      /**
       * Upload a local folder's file contents as source items. When
       * triggerSynthesis is true, the server chains straight into launching
       * a synthesis run scoped to exactly the items this call inserts (not
       * every ready item in the workspace) — one request/response instead
       * of a separate triggerSynthesisRun call with plumbed-through IDs.
       */
      uploadSourceItems: {
        params: { folderPath: string; triggerSynthesis?: boolean };
        response: ActionResult & { inserted?: number; skipped?: string[]; runId?: string; machineId?: string; reason?: string; synthesisError?: string };
      };

      /**
       * Onboarding's single entrypoint for starting a workspace's first
       * synthesis run: uploads a local folder's contents as source items
       * (if given) then launches synthesis, always passing dimension hints
       * for the bootstrap prompt. Internally still calls the same
       * source-items / synthesis-runs backend routes as uploadSourceItems /
       * triggerSynthesisRun.
       */
      bootstrapWorkspaceContext: {
        params: { folderPath?: string; dimensions: { dimensionName: string; dimensionDescription: string }[] };
        response: ActionResult & { inserted?: number; skipped?: string[]; runId?: string; machineId?: string; reason?: string; synthesisError?: string };
      };

      /** Return support config baked in at build time. Empty strings for OSS builds. */
      getCrispConfig: { params: void; response: { website_id: string; cal_url: string; history_endpoint: string; history_secret: string } };

      /** Read analytics config from ~/.draft/config.json. Generates anonymous_id on first call. */
      getAnalyticsConfig: { params: void; response: AnalyticsConfig };

      /** Patch analytics config (consent, etc.) in ~/.draft/config.json. */
      setAnalyticsConfig: { params: Partial<AnalyticsConfig>; response: ActionResult };
      getPrivacy: { params: { signedIn: boolean }; response: PrivacyState };
      setPrivacy: { params: { analytics_consent: boolean }; response: ActionResult & { privacy?: PrivacyState } };

      /** Apply a staged update — quits + relaunches. Only valid when updateReady is true. */
      applyUpdate: { params: void; response: ActionResult };

      /** Read version + channel from bundled version.json. Returns { version: "dev", channel: "dev" } in dev builds. */
      getAppVersion: { params: void; response: AppVersionInfo };

      /** List the last 50 cloud synthesis runs for the active workspace. Returns [] if signed out or the request fails. */
      getWorkspaceRuns: { params: void; response: WorkspaceRun[] };

      startBrowserSignIn: { params: void; response: ActionResult };
      cancelBrowserSignIn: { params: void; response: ActionResult };
      signOut: { params: void; response: ActionResult };
      getUserIdentity: { params: void; response: UserIdentity };

      /**
       * Mark the signed-in user's onboarding wizard as complete, server-side
       * (POST /onboarding-complete). Called once, from the wizard's final
       * "Let's go" step. Updates the cached identity in place so App.tsx's
       * onboarding gate flips immediately without a full /whoami re-fetch.
       */
      completeOnboarding: { params: void; response: ActionResult & { onboardingCompletedAt?: string | null } };
    };
    messages: {
      /** Renderer asks bun to fire a macOS notification. */
      sendNotification: { title: string; subtitle?: string; body?: string };
      /** Renderer asks Bun to open a URL in the system browser. */
      openUrl: { url: string };
      /** Open the active workspace folder in Finder. */
      openWorkspaceInFinder: Record<string, never>;
      /** Renderer asks bun to start an update check. Result arrives via webview messages. */
      requestUpdateCheck: Record<string, never>;
    };
  }>;

  /**
   * Webview-side handlers.
   * requests: bun calls → renderer responds (awaitable)
   * messages: bun sends → renderer handles (fire-and-forget)
   */
  webview: RPCSchema<{
    requests: {};
    messages: {

      /** Daemon completed a capture cycle. */
      captureComplete: { source: string };

      /** Bun started an update check. */
      updateCheckStarted: Record<string, never>;

      /** Update downloaded and staged — ready to apply. */
      updateAvailable: { version: string };

      /** Update check completed — already on latest version. */
      updateNotAvailable: Record<string, never>;

      /** Update check or download failed. */
      updateCheckFailed: { error: string };

      /** Synthesis job completed — renderer should re-fetch activity runs. Reserved for sentinel file watcher (TODO-3); not emitted in v1. */
      runComplete: { profile: string; source: string; status: string; proposalsGenerated: number };

      signInProgress: {
        phase: "awaiting_approval" | "complete" | "error";
        error?: string;
      };

      githubInstallProgress: {
        phase: "awaiting_approval" | "connected" | "error";
        error?: string;
      };

      /** Local auth session was cleared by the main process. */
      authStateChanged: { signedIn: boolean };

      /** Cached identity fields (e.g. onboardingCompletedAt) changed on disk — re-read without a /whoami round trip. */
      identityRefreshNeeded: Record<string, never>;
    };
  }>;
};
