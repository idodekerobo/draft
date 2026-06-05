// core/src/appState.ts — first-run/setup-ready detection for desktop routing
//
// Pure filesystem reads only. No subprocesses, no network, no console output.

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ACTIVE_PROFILE_FILE, BACKGROUND_DIR, getActiveProfile, getWorkspacePath, type ProfileOpts } from "./config";

export type AppUserState =
  | "no-profile"
  | "no-context"
  | "ready-stopped"
  | "ready-running";

export interface AppState {
  userState: AppUserState;
  hasActiveProfile: boolean;
  hasContextFiles: boolean;
  daemonState: "running" | "stopped" | "never-started";
  heartbeatAgeMs: number | null;
  activeProfile: string;
}

export interface AppStateOpts extends ProfileOpts {
  backgroundDir?: string;
  nowMs?: number;
}

const STALE_HEARTBEAT_MS = 2 * 60 * 1000;

export function getAppState(opts?: AppStateOpts): AppState {
  const activeProfileFile = opts?.activeProfileFile ?? ACTIVE_PROFILE_FILE;
  const hasActiveProfile = readHasActiveProfile(activeProfileFile);
  const activeProfile = hasActiveProfile ? getActiveProfile(opts) : "default";
  const workspacePath = getWorkspacePath(activeProfile, opts);
  const hasContextFiles = hasMarkdownFile(join(workspacePath, "context"));
  const heartbeatPath = join(opts?.backgroundDir ?? BACKGROUND_DIR, "state", "last-heartbeat");
  const heartbeatAgeMs = readHeartbeatAgeMs(heartbeatPath, opts?.nowMs ?? Date.now());

  const daemonState = heartbeatAgeMs === null
    ? "never-started"
    : heartbeatAgeMs < STALE_HEARTBEAT_MS
      ? "running"
      : "stopped";

  let userState: AppUserState;
  if (!hasActiveProfile) {
    userState = "no-profile";
  } else if (!hasContextFiles) {
    userState = "no-context";
  } else if (daemonState === "running") {
    userState = "ready-running";
  } else {
    userState = "ready-stopped";
  }

  return {
    userState,
    hasActiveProfile,
    hasContextFiles,
    daemonState,
    heartbeatAgeMs,
    activeProfile,
  };
}

function readHasActiveProfile(file: string): boolean {
  try {
    return readFileSync(file, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

function readHeartbeatAgeMs(file: string, nowMs: number): number | null {
  try {
    return Math.max(0, nowMs - statSync(file).mtimeMs);
  } catch {
    return null;
  }
}

function hasMarkdownFile(dir: string): boolean {
  if (!existsSync(dir)) return false;

  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (hasMarkdownFile(join(dir, entry.name))) return true;
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        return true;
      }
    }
  } catch {
    return false;
  }

  return false;
}
