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
  | "first-run"
  | "setup-incomplete"
  | "ready-daemon-stopped"
  | "ready-daemon-running";

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

export interface ProfileList {
  names: string[];
  active: string;
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

      /** Launch a terminal session for the given tool + profile. */
      launchSession: { params: SessionLaunchConfig; response: LaunchResult };

      /** Start the background daemon via launchctl. */
      startDaemon: { params: void; response: ActionResult };

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
    };
    messages: {
      /** Renderer asks bun to fire a macOS notification. */
      sendNotification: { title: string; subtitle?: string; body?: string };
      /** Renderer asks Bun to open a URL in the system browser. */
      openUrl: { url: string };
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

      /** Daemon heartbeat went stale — daemon has stopped. Phase 1. */
      daemonStopped: Record<string, never>;

      /** Daemon completed a capture cycle. */
      captureComplete: { source: string };

      /** Update the proposal badge count in the UI. */
      badgeUpdate: { profile: string; count: number };

      /** Active profile changed outside or inside desktop. */
      profileChanged: { profile: string };
    };
  }>;
};
