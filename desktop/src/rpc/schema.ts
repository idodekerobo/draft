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

// ── Shared payload types ───────────────────────────────────────────────────────
// Defined inline here (not imported from draft-core) so the renderer can safely
// import this file without pulling in any Node/Bun-only modules.

export type DaemonState = "running" | "stopped" | "degraded";

export interface ActivityRun {
  id: string;
  profile: string;
  source: string;
  sessionId: string | null;
  cwd: string | null;
  startedAt: string;        // ISO 8601
  endedAt: string | null;
  status: "success" | "failed" | "skipped" | "timeout";
  durationMs: number | null;
  proposalsGenerated: number;
  skipReason: string | null;
  errorMsg: string | null;
}

export interface IntegrationStatus {
  granola: boolean;
  slack: boolean;
  github: boolean;
}

/** Coding tools that have been set up with `draft add <tool>`. */
export interface InstalledToolsStatus {
  "claude-code": boolean;
  codex: boolean;
  cursor: boolean;
  openclaw: boolean;
  hermes: boolean;
}

export interface DaemonStatus {
  state: DaemonState;
  pid: string | null;
  lastExit: string | null;
  isRegistered: boolean;
  /** Active profile name — read from last-heartbeat JSON. Null if daemon never ran. */
  profile: string | null;
  /** ISO timestamp of last synthesis run — read from last-heartbeat JSON. Null if no sync yet. */
  lastSync: string | null;
  /** First-run/setup-ready state for renderer routing and setup copy. */
  appState: AppState;
  /** Which integrations are connected — read from integrations.json for the active profile. */
  integrations: IntegrationStatus;
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

export interface ProposalSummary {
  filename: string;
  source: string;
  dimension: string;
  action: string;
  timestamp: string;
  summary: string;
  createdAt: string;
  body: string;
  currentContent: string;
  /** Full file text including YAML frontmatter — shown by "View raw". */
  rawContent: string;
  /** Content of the first context_update — used for diff preview. */
  content: string;
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
}

export interface McpManifest {
  version: 4;
  schema_version: 4;
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

export interface LoadDiffEntry {
  dimension: string;
  action: string;
  summary: string;
}

export interface LoadDiffResult {
  entries: LoadDiffEntry[];
  cursorLine: number;
  lastLoaded: string | null;
}

/** Returned by getTeamDiff — includes staging tmpDir for HITL apply phase. */
export interface TeamDiffResult {
  entries: LoadDiffEntry[];
  cursorLine: number;
  /** Absolute path to the staging clone. Pass to applyTeamDiff to apply. Empty string if clone failed. */
  tmpDir: string;
  /** False when collaboration is not configured — UI hides sync bar entirely. */
  collabConfigured: boolean;
}

export interface LocalConfig {
  teamLoadMode: "auto" | "review";
  launchOnLogin: boolean;
  notificationsEnabled: boolean;
  disabledContextSections: string[];
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

/** Detail for a single input source integration (granola, slack, github). */
export interface IntegrationDetail {
  connected: boolean;
  lastConnected: string | null;
  /** "mcp"|"api" for Granola; "passive"|"tagged" for Slack; null otherwise. */
  mode: string | null;
  /** Slack: number of configured channels. Null for other sources. */
  channels: number | null;
  /** GitHub: list of watched repos. Empty for other sources. */
  repos: string[];
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
  };
}

export interface ContextFileEntry {
  relativePath: string;
  label: string;
  content: string;
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

// ── RPC schema ─────────────────────────────────────────────────────────────────

export type AppRPCType = {
  /**
   * Bun-side handlers.
   * requests: renderer calls → bun responds (awaitable)
   * messages: renderer sends → bun handles (fire-and-forget)
   */
  bun: RPCSchema<{
    requests: {
      /** Get current daemon state. */
      getStatus: { params: void; response: DaemonStatus };

      /** List pending proposals for the active workspace. */
      getProposals: { params: void; response: ProposalSummary[] };

      /** List available profiles and the active profile. */
      getProfiles: { params: void; response: ProfileList };

      /** Switch the active profile and restart profile-scoped desktop watchers. */
      switchProfile: { params: { profile: string }; response: ActionResult & { active?: string } };

      /** Create a new workspace directory, set it as active, and fire profileChanged. */
      createProfile: { params: { name: string }; response: ActionResult & { active?: string } };

      /** Launch a terminal session for the given tool + profile. */
      launchSession: { params: SessionLaunchConfig; response: LaunchResult };

      /** Start the background daemon via launchctl. */
      startDaemon: { params: void; response: ActionResult };

      /** Start the cross-agent skill watcher. Called after onboarding completes. */
      startSkillWatcher: { params: void; response: void };

      /** Stop the background daemon via launchctl. */
      stopDaemon: { params: void; response: ActionResult };

      /** Accept a pending proposal (moves to accepted/). */
      acceptProposal: { params: { filename: string }; response: ActionResult };

      /** Reject a pending proposal (moves to rejected/). */
      rejectProposal: { params: { filename: string }; response: ActionResult };

      /** Read CHANGES.jsonl delta since last cursor (from local workspace copy — what hook applied). */
      loadDiff: { params: void; response: LoadDiffResult };

      /** Fetch team diff from remote: shallow-clone → read CHANGES.jsonl delta → return entries + tmpDir. */
      getTeamDiff: { params: void; response: TeamDiffResult };

      /** Apply staged tmpDir → workspace: copy context + CHANGES.jsonl, update cursor, delete tmpDir. */
      applyTeamDiff: { params: { tmpDir: string; cursorLine: number }; response: ActionResult };

      /** Read per-profile local config (teamLoadMode). */
      getLocalConfig: { params: void; response: LocalConfig };

      /** Patch per-profile local config. */
      setLocalConfig: { params: Partial<LocalConfig>; response: ActionResult };

      /** List all readable context files for the active workspace. */
      getContextFiles: { params: void; response: ContextFileEntry[] };

      /** Rich connection status for all intelligence tools and input sources. */
      getConnectedApps: { params: void; response: ConnectedAppsStatus };

      /** Disconnect an input source by setting connected=false in integrations.json. */
      disconnectIntegration: { params: { source: "granola" | "slack" | "github" }; response: ActionResult };

      /**
       * Connect GitHub natively via `gh auth login --web`.
       * Spawns the OAuth flow in the browser (fire-and-forget) and returns immediately.
       * Writes connected=true to integrations.json when gh auth completes.
       * Renderer should poll getConnectedApps until github.connected === true.
       */
      connectGitHub: { params: void; response: ActionResult };

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

      /** Build and return the Slack app creation URL with the manifest pre-filled. */
      getSlackManifestUrl: { params: void; response: { ok: boolean; url?: string; error?: string } };

      /** Persist Slack bot and app credentials and connection status for the daemon. */
      connectSlack: { params: { botToken: string; appToken: string }; response: ActionResult };

      /** Open the native folder picker for an optional local-context import. */
      selectSetupFolder: { params: void; response: { folderPath: string | null } };

      /** Start a non-interactive CLI session to create the active profile's context. */
      runHeadlessSetup: { params: { mode: "scratch" | "import" | "github"; folderPath?: string; githubUrl?: string; runner?: "claude" | "codex" }; response: ActionResult };

      /** Detect which CLI runners are installed. */
      getAvailableRunners: { params: void; response: { runners: Array<{ name: "claude" | "codex"; installed: boolean }> } };

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

      /** Return Crisp website ID baked in at build time. Empty string for OSS builds. */
      getCrispConfig: { params: void; response: { website_id: string } };

      /** Read analytics config from ~/.draft/config.json. Generates anonymous_id on first call. */
      getAnalyticsConfig: { params: void; response: AnalyticsConfig };

      /** Patch analytics config (consent, replay_enabled, etc.) in ~/.draft/config.json. */
      setAnalyticsConfig: { params: Partial<AnalyticsConfig>; response: ActionResult };

      /** Apply a staged update — quits + relaunches. Only valid when updateReady is true. */
      applyUpdate: { params: void; response: ActionResult };

      /** Read version + channel from bundled version.json. Returns { version: "dev", channel: "dev" } in dev builds. */
      getAppVersion: { params: void; response: AppVersionInfo };

      /** List the last 50 activity runs for the active profile. */
      getActivityRuns: { params: void; response: ActivityRun[] };
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
    requests: {
      /** Bun asks renderer to show a confirm-load dialog. */
      confirmLoad: { params: LoadDiffResult; response: boolean };
    };
    messages: {
      /** New proposal(s) arrived from the daemon. */
      proposalAdded: { profile: string; source: string; count: number };

      /** A newly installed skill was made available to the other agent. */
      skillsChanged: { count: number };

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

      /** Daemon heartbeat went stale — daemon has stopped. Phase 1. */
      daemonStopped: Record<string, never>;

      /** Daemon completed a capture cycle. */
      captureComplete: { source: string };

      /** Update the proposal badge count in the UI. */
      badgeUpdate: { profile: string; count: number };

      /** Active profile changed outside or inside desktop. */
      profileChanged: { profile: string };

      /** Bun asks renderer to re-fetch status immediately (e.g. after a menu start/stop action). */
      requestStatusRefresh: Record<string, never>;

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
    };
  }>;
};
