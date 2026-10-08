// core/src/appState.ts — first-run/setup-ready detection for desktop routing
//
// Pure filesystem reads only. No subprocesses, no network, no console output.

import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { ACTIVE_PROFILE_FILE, getActiveProfile, getWorkspacePath, type ProfileOpts } from "./config";

export type AppUserState =
  | "no-profile"
  | "no-context"
  | "ready";

export interface AppState {
  userState: AppUserState;
  hasActiveProfile: boolean;
  hasContextFiles: boolean;
  activeProfile: string;
}

export type AppStateOpts = ProfileOpts;

export function getAppState(opts?: AppStateOpts): AppState {
  const activeProfileFile = opts?.activeProfileFile ?? ACTIVE_PROFILE_FILE;
  const hasActiveProfile = readHasActiveProfile(activeProfileFile);
  const activeProfile = hasActiveProfile ? getActiveProfile(opts) : "default";
  const workspacePath = getWorkspacePath(activeProfile, opts);
  const hasContextFiles = hasMarkdownFile(join(workspacePath, "context"));
  let userState: AppUserState;
  if (!hasActiveProfile) {
    userState = "no-profile";
  } else if (!hasContextFiles) {
    userState = "no-context";
  } else {
    userState = "ready";
  }

  return {
    userState,
    hasActiveProfile,
    hasContextFiles,
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
