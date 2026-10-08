// desktop/src/main/legacyDaemon.ts — removes the retired local background daemon
//
// Older builds installed a launchd agent plus ~/.draft/background. Idempotent
// and non-fatal; safe to run on every launch.

import { existsSync, readFileSync, rmSync, unlinkSync } from "fs";
import { capture } from "../exec";

const LABEL = "com.draft.daemon";

export interface LegacyDaemonPaths {
  plistPath: string;
  backgroundDir: string;
  uid: number;
}

export interface LegacyDaemonDeps {
  run: (cmd: string[]) => Promise<unknown>;
  kill: (pid: number) => void;
}

export function defaultLegacyDaemonPaths(): LegacyDaemonPaths {
  const home = process.env.HOME ?? "";
  return {
    plistPath: `${home}/Library/LaunchAgents/${LABEL}.plist`,
    backgroundDir: `${home}/.draft/background`,
    uid: process.getuid?.() ?? 0,
  };
}

export async function removeLegacyDaemon(
  paths: LegacyDaemonPaths = defaultLegacyDaemonPaths(),
  deps: LegacyDaemonDeps = { run: capture, kill: (pid) => process.kill(pid, "SIGTERM") },
): Promise<void> {
  if (process.env.DRAFT_DESKTOP_DEV === "1") return;
  const hasPlist = existsSync(paths.plistPath);
  const hasDir = existsSync(paths.backgroundDir);
  if (!hasPlist && !hasDir) return;

  try {
    if (hasPlist) {
      await deps.run(["launchctl", "bootout", `gui/${paths.uid}/${LABEL}`]).catch(() => {});
      unlinkSync(paths.plistPath);
    }
    const pidFile = `${paths.backgroundDir}/draft-background.pid`;
    if (existsSync(pidFile)) {
      const pid = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
      if (pid > 0) {
        try { deps.kill(pid); } catch { /* already gone */ }
      }
    }
    rmSync(paths.backgroundDir, { recursive: true, force: true });
    console.log("[draft-desktop] removed legacy background daemon");
  } catch (err) {
    console.warn(`[draft-desktop] legacy daemon cleanup failed: ${err instanceof Error ? err.message : err}`);
  }
}
