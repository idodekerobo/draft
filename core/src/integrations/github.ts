// core/src/integrations/github.ts — GitHub integration logic
//
// Used by: draft-desktop (RPC handlers), draft-cli (future)
//
// Fast path: gh already authenticated — mark connected immediately and return.
// Slow path: spawn `gh auth login --web`, return immediately (fire-and-forget),
//   write integrations.json in background when gh exits, call onComplete.
//
// Desktop uses fire-and-forget + renderer polling.
// CLI will await a wrapper that resolves the background promise directly.

import { capture } from "../exec";
import { writeIntegrations, readIntegrations } from "../config";
import { resolveRunnerBin } from "../agents/headless";

export type GhCliStatus = "ok" | "not_found" | "not_authenticated";

export async function checkGhCli(): Promise<GhCliStatus> {
  const ghBin = await resolveRunnerBin("gh");
  if (!ghBin) return "not_found";

  const authCheck = await capture([ghBin, "auth", "status"]);
  return authCheck.exitCode === 0 ? "ok" : "not_authenticated";
}

export type GitHubConnectResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ConnectGitHubOpts {
  workspace: string;
  /** Called when the connection is confirmed (fast path: immediately; slow path: after OAuth). */
  onComplete?: () => void;
}

export async function connectGitHub(opts: ConnectGitHubOpts): Promise<GitHubConnectResult> {
  const { workspace, onComplete } = opts;
  const ghBin = await resolveRunnerBin("gh");
  if (!ghBin) {
    return { ok: false, error: "gh CLI not found. Install it with: brew install gh" };
  }

  // Fast path: gh already authenticated.
  const authCheck = await capture([ghBin, "auth", "status"]);
  if (authCheck.exitCode === 0) {
    try {
      writeGitHubConnected(workspace);
      onComplete?.();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to save GitHub connection." };
    }
  }

  // Slow path: open browser OAuth. Return immediately so the caller isn't blocked.
  // Background promise writes integrations.json when gh exits cleanly.
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([ghBin, "auth", "login", "--web"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { ok: false, error: "gh CLI not found. Install it with: brew install gh" };
  }

  proc.exited.then((code) => {
    if (code !== 0) return;
    try {
      writeGitHubConnected(workspace);
      onComplete?.();
    } catch { /* non-fatal */ }
  }).catch(() => {});

  return { ok: true };
}

function writeGitHubConnected(workspace: string): void {
  const result = readIntegrations(workspace);
  const current = result.ok ? result.integrations : {};
  writeIntegrations(workspace, {
    ...current,
    github: { ...(current.github ?? {}), connected: true, last_connected: new Date().toISOString() },
  });
}
