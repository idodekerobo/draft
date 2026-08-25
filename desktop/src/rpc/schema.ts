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

export interface ScannedSkillEntry {
  name: string;
  agent: "claude-code" | "codex";
  dirPath: string;
  description: string;
  descriptionTokenCount: number;
  tokenCount: number;
  synced?: boolean;
}

export interface ScanDirError {
  dir: string;
  agent: "claude-code" | "codex";
  message: string;
}

export interface ScannedMCPEntry {
  name: string;
  agent: "claude-code" | "codex";
  config: Record<string, unknown>;
}

export interface ScanSkillsResult {
  skills: ScannedSkillEntry[];
  scanErrors?: ScanDirError[];
  mcpServers?: ScannedMCPEntry[];
}

/** A skill that was detected as a new real directory not yet in the manifest. */
export interface PendingSkillEntry {
  id: string;
  name: string;
  source_agent: "claude-code" | "codex";
  source_path: string;
  skill_dir_hash: string;
  description: string;
  tokenCount: number;
}

/** Both agents have a real directory with the same skill name — needs user resolution. */
export interface SameNameConflict {
  name: string;
  "claude-code": { path: string; skill_dir_hash: string };
  codex: { path: string; skill_dir_hash: string };
}

/** User's decision for resolving a same-name skill conflict. */
export type ConflictResolution =
  | { action: "use-source"; authoritative_agent: "claude-code" | "codex" }
  | { action: "keep-local" };

// ── MCP sync types ─────────────────────────────────────────────────────────────

export interface CanonicalMcp {
  type: "http";
  url: string;
  headers?: Record<string, {
    value_env?: string;
    value_literal?: string;
    secret: boolean;
  }>;
  disabled?: boolean;
}

export interface McpManifestSyncEntry {
  synced_at: string;
  target_name: string;
}

export interface McpManifestEntry {
  id: string;
  name: string;
  source_agent: "claude-code" | "codex";
  sync_canonical: CanonicalMcp;
  sync_canonical_hash: string;
  source_snapshot: { original_config: Record<string, unknown> };
  env_var_mapping: Record<string, string>;
  synced_to: Partial<Record<"claude-code" | "codex", McpManifestSyncEntry>>;
  removed_at: string | null;
  /** "personal" = local personal MCP, "team" = shared via workspace. */
  kind: "personal" | "team";
  /** For team MCPs: env var names the local user must supply before install. */
  pending_secrets?: string[];
}

export interface McpManifest {
  version: 5;
  schema_version: 5;
  mcps: Record<string, McpManifestEntry>;
  name_conflicts: Record<string, {
    agents: Array<"claude-code" | "codex">;
    resolved: boolean;
    authoritative_agent: "claude-code" | "codex" | null;
  }>;
}

export interface PendingMcpEntry {
  id: string;
  name: string;
  source_agent: "claude-code" | "codex";
  config: Record<string, unknown>;
  canonical: CanonicalMcp;
  conflict?: boolean;
}

export interface McpConflict {
  name: string;
  "claude-code": { config: Record<string, unknown>; canonical: CanonicalMcp };
  codex: { config: Record<string, unknown>; canonical: CanonicalMcp };
}

export interface McpDriftEntry {
  id: string;
  name: string;
  source_agent: "claude-code" | "codex";
  target_agent: "claude-code" | "codex";
  expected: CanonicalMcp;
  observed: Record<string, unknown>;
}

export interface McpReconcileResult {
  resynced: string[];
  tombstoned: string[];
  drifted: McpDriftEntry[];
  errors: string[];
}

export type HeadlessSetupPhase = "starting" | "running" | "writing" | "complete" | "error";

export interface ProfileDetail {
  name: string;
  hasContext: boolean;
}

export interface ProfileList {
  names: string[];
  active: string;
  details: ProfileDetail[];
}

export interface LocalConfig {
  launchOnLogin: boolean;
  notificationsEnabled: boolean;
  disabledContextSections: string[];
  codexScanIntervalMinutes: number | null;
  claudeCodeSynthesis: boolean;
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

export interface AnalyticsConfig {
  consent: "pending" | "opted_in" | "opted_out";
  replay_enabled: boolean;
  anonymous_id: string;
  posthog_host?: string;
  /** Runtime-only: sourced from build-config.json, never persisted to ~/.draft/config.json. */
  posthog_key?: string;
}

/** Full text injected at session start, with token estimate. */
export interface SessionPreview {
  text: string;
  tokenEstimate: number;
}

/**
 * A single context section that can be toggled in Settings.
 * "full" = entire file injected; "summary" = frontmatter description only.
 */
export interface ContextSection {
  name: string;
  label: string;
  injectionMode: "full" | "summary";
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
  /** "mcp"|"api" for Granola; "passive"|"tagged" for Slack; null otherwise. Fireflies has no mode — always null. */
  mode: string | null;
  /** Slack: number of channels in the persisted bot membership set. Null for other sources. */
  channels: number | null;
  /** Slack: persisted bot membership returned by the cloud connection status. */
  channelIds?: string[];
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
    /** Workspace-wide coding-session-capture toggle. Not a credentialed integration -- just a status flip. */
    claude_session: IntegrationDetail;
  };
  claudeCode: { connected: boolean };
}

/**
 * A Slack channel the bot can see, from conversations.list.
 * Mirrors draft-core/integrations/slack's SlackChannel rather than importing it,
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

export interface ContextFileEntry {
  relativePath: string;
  label: string;
  content: string;
  /** Verbatim YAML frontmatter block (including `---` delimiters), or "" if none. Must be re-prepended on save — content is always frontmatter-stripped. */
  frontmatterRaw: string;
  /**
   * dim       — dimension index.md (has expand arrow for log entries)
   * log       — log/ entry child of a dim (shown when dim is expanded)
   * standalone — single root-level .md file (like tensions.md, no expand)
   * group-child — file inside a multi-file group (decisions/, research/, etc.)
   */
  kind: "dim" | "log" | "standalone" | "group-child";
  /** Dimension or group id — e.g. "company", "decisions", "research" */
  group: string;
  /** Human-readable label for the group — used in section headers */
  groupLabel: string;
}

/** A team MCP that is waiting for the user to supply missing API credentials. */
export interface PendingCredentialMcp {
  name: string;
  url: string;
  required_secrets: string[];
}

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

      /** List available profiles and the active profile. */
      getProfiles: { params: void; response: ProfileList };

      /** Switch the active profile and restart profile-scoped desktop watchers. */
      switchProfile: { params: { profile: string }; response: ActionResult & { active?: string } };

      /** Create a new workspace directory, set it as active, and fire profileChanged. */
      createProfile: { params: { name: string }; response: ActionResult & { active?: string } };

      /** Launch a terminal session for the given tool + profile. */
      launchSession: { params: SessionLaunchConfig; response: LaunchResult };

      /** Start the cross-agent skill watcher. Called after onboarding completes. */
      startSkillWatcher: { params: void; response: void };

      /** Read per-profile local config. */
      getLocalConfig: { params: void; response: LocalConfig };

      /** Patch per-profile local config. */
      setLocalConfig: { params: Partial<LocalConfig>; response: ActionResult };

      /** List all readable context files for the active workspace. */
      getContextFiles: { params: void; response: ContextFileEntry[] };

      /** Rich connection status for all intelligence tools and input sources. */
      getConnectedApps: { params: void; response: ConnectedAppsStatus };

      /** Disconnect an input source. granola/github flip connected=false in integrations.json; slack/fireflies/linear/claude_session revoke the workspace's cloud source_connections row. */
      disconnectIntegration: { params: { source: "granola" | "slack" | "github" | "fireflies" | "linear" | "claude_session" }; response: ActionResult };

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

      /** Scan Claude Code and Codex skill directories for skills Draft does not manage. */
      scanSkills: { params: void; response: ScanSkillsResult };

      /** Create cross-agent symlinks for the selected scanned skills. */
      importSkills: { params: { skills: ScannedSkillEntry[] }; response: ActionResult & { created: number; skipped: number } };

      /** Remove cross-agent symlinks for the given skills. */
      removeSkills: { params: { skills: ScannedSkillEntry[] }; response: ActionResult & { removed: number } };

      /** Return all skills pending approval and any same-name conflicts. */
      getSkillsPending: { params: void; response: { pending: PendingSkillEntry[]; conflicts: SameNameConflict[] } };

      /** Approve pending skills — create their cross-agent symlinks and mark them approved in the manifest. */
      approveSkills: { params: { skills: PendingSkillEntry[] }; response: ActionResult & { created: number } };

      /** Resolve a same-name conflict by picking an authoritative agent or keeping both local. */
      resolveSkillConflict: { params: { conflict: SameNameConflict; resolution: ConflictResolution }; response: ActionResult };

      /** Return all MCP entries pending approval and any same-name conflicts. */
      getMcpPending: { params: void; response: { pending: PendingMcpEntry[]; conflicts: McpConflict[] } };

      /** Approve pending MCPs — write manifest entries and sync to target agent config. */
      approveMcps: { params: { mcps: PendingMcpEntry[] }; response: ActionResult };

      /** Resolve an MCP name conflict by picking one agent as authoritative. */
      resolveMcpConflict: { params: { name: string; authoritative_agent: "claude-code" | "codex" }; response: ActionResult };

      /** Remove a Draft-managed MCP from the manifest and both agent configs. */
      removeMcp: { params: { id: string }; response: ActionResult };

      /** Return the full MCP manifest. */
      getMcpManifest: { params: void; response: McpManifest };

      /** Register Granola's MCP server with Claude Code and persist connection status. */
      connectGranolaMCP: { params: void; response: ActionResult };

      /** Persist a Granola API key and connection status for the daemon. */
      connectGranolaAPI: { params: { apiKey: string }; response: ActionResult };

      /** Persist Fireflies API credentials in Draft Cloud and return webhook setup values. */
      connectFireflies: { params: { apiKey: string }; response: ActionResult & { webhookUrl?: string; webhookSecret?: string } };

      /** Persist a Linear personal API key in Draft Cloud; the server creates the webhook itself. */
      connectLinear: { params: { apiKey: string }; response: ActionResult };

      /** Persist a Claude Code OAuth token in Draft Cloud for the workspace's cloud sandbox to use. */
      connectClaudeCode: { params: { token: string }; response: ActionResult };

      /** Turn on the workspace-wide coding-session-capture toggle (no credential). Turn off via disconnectIntegration. */
      connectSessionTracking: { params: void; response: ActionResult };

      /** Open the native folder picker for choosing a repo to enable coding-session capture in. */
      selectSessionRepoFolder: { params: void; response: { folderPath: string | null } };

      /** Desktop-native equivalent of `draft sessions enable claude-code --dir <folderPath>` (CLI has a separate auth store). */
      enableSessionCaptureForRepo: { params: { folderPath: string }; response: ActionResult & { hookChanged?: boolean } };

      /** Desktop-native equivalent of `draft sessions rotate --dir <folderPath>`. */
      rotateSessionCaptureForRepo: { params: { folderPath: string }; response: ActionResult };

      /** Desktop-native equivalent of `draft sessions disable --dir <folderPath>`. */
      disableSessionCaptureForRepo: { params: { folderPath: string }; response: ActionResult & { hookRemoved?: boolean; revoked?: boolean } };

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

      /**
       * Start a non-interactive CLI session to create the active profile's context.
       * `dimensions` overrides the standard company/product/team/priorities set —
       * omit to use the default four.
       */
      runHeadlessSetup: { params: { mode: "scratch" | "import" | "github"; folderPath?: string; githubUrl?: string; runner?: "claude" | "codex"; dimensions?: string[] }; response: ActionResult };

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

      /**
       * Run inject-context.sh and return the full text that would be injected
       * at session start, plus a rough token estimate (chars / 4).
       */
      getSessionPreview: { params: void; response: SessionPreview };

      /**
       * List context sections for the active profile — one per context/{name}/index.md
       * dimension, plus "memory" if personal/memory.md exists.
       */
      getContextSections: { params: void; response: ContextSection[] };

      /** Open Finder with the file selected (macOS `open -R`). */
      revealInFinder: { params: { relativePath: string }; response: ActionResult };

      /** Return support config baked in at build time. Empty strings for OSS builds. */
      getCrispConfig: { params: void; response: { website_id: string; cal_url: string; history_endpoint: string; history_secret: string } };

      /** Read analytics config from ~/.draft/config.json. Generates anonymous_id on first call. */
      getAnalyticsConfig: { params: void; response: AnalyticsConfig };

      /** Patch analytics config (consent, replay_enabled, etc.) in ~/.draft/config.json. */
      setAnalyticsConfig: { params: Partial<AnalyticsConfig>; response: ActionResult };

      /** Apply a staged update — quits + relaunches. Only valid when updateReady is true. */
      applyUpdate: { params: void; response: ActionResult };

      /** Read version + channel from bundled version.json. Returns { version: "dev", channel: "dev" } in dev builds. */
      getAppVersion: { params: void; response: AppVersionInfo };

      /** List the last 50 cloud synthesis runs for the active workspace. Returns [] if signed out or the request fails. */
      getWorkspaceRuns: { params: void; response: WorkspaceRun[] };

      /** Supply a missing secret for a team MCP in pending-credentials state. */
      setMcpSecret: { params: { name: string; envVar: string; value: string }; response: ActionResult & { nowInstalled: boolean } };

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
      /** A newly installed skill was made available to the other agent. */
      skillsChanged: { count: number };

      /** Team MCPs were installed or removed (e.g. after draft load). */
      mcpsChanged: { count: number };

      /** New MCPs were detected and are waiting for user approval in Settings > MCPs. */
      mcpsPendingApproval: { pending: PendingMcpEntry[] };

      /** Same-name MCP conflict detected — both agents have an entry with the same name. */
      mcpsConflict: { conflicts: McpConflict[] };

      /** Approved MCPs drifted from their canonical form in a target agent. */
      mcpsDrifted: { drifted: McpDriftEntry[] };

      /** New skills were detected and are waiting for user approval in Settings > Skills. */
      skillsPendingApproval: { pending: PendingSkillEntry[] };

      /** Same-name skill conflict detected — both agents have a real directory with the same name. */
      skillsConflict: { conflicts: SameNameConflict[] };

      /** Status update from the headless context-setup process. */
      headlessProgress: { phase: HeadlessSetupPhase; label: string; error?: string };

      /** Daemon completed a capture cycle. */
      captureComplete: { source: string };

      /** Active profile changed outside or inside desktop. */
      profileChanged: { profile: string };

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

      /** One or more team MCPs are missing credentials after profile switch or load-team. */
      mcpsPendingCredentials: { mcps: PendingCredentialMcp[] };

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
