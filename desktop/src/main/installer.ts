// desktop/src/main/installer.ts — first-launch installer for Draft.app
//
// Called from the onboarding wizard when appState.userState === "no-profile".
// Extracts the bundled draft binary, symlinks it to /usr/local/bin/draft,
// then delegates all tool installs to `draft add <tool>` (single source of truth).
//
// Idempotent — safe to call if partially or fully installed.

import { existsSync, mkdirSync, copyFileSync, chmodSync, symlinkSync, unlinkSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import Electrobun from "electrobun/bun";
import { getBundledBinPath, getBundledBackgroundDir, getBundledPluginDir, getBundledBunPath, getBundledTmuxPath } from "./bundlePath";
import { capture } from "../exec";

const LOG_FILE = `${process.env.HOME}/.draft/logs/desktop-installer.log`;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [installer] ${msg}\n`;
  console.log(line.trimEnd());
  try {
    mkdirSync(`${process.env.HOME}/.draft/logs`, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* non-fatal */ }
}

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

const DRAFT_BIN_DIR     = `${process.env.HOME}/.draft/bin`;
const DRAFT_BIN_PATH    = `${DRAFT_BIN_DIR}/draft`;
const SYSTEM_LINK       = "/usr/local/bin/draft";
const BIN_VERSION_STAMP = `${DRAFT_BIN_DIR}/.version`;

/**
 * Best-effort resolution of the running app's version, for stamping
 * ~/.draft/bin/.version. Returns null in dev mode or on any failure
 * (matches the try/catch pattern index.ts uses around the same call).
 */
async function resolveAppVersion(): Promise<string | null> {
  try {
    const info = await Electrobun.Updater.getLocalInfo();
    return info?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Record the app version ~/.draft/bin was last extracted/synced from.
 * Best-effort — a failed write just means we re-copy on the next launch.
 */
function writeBinVersionStamp(appVersion: string): void {
  try {
    mkdirSync(DRAFT_BIN_DIR, { recursive: true });
    writeFileSync(BIN_VERSION_STAMP, appVersion);
  } catch (err) {
    log(`failed to write bin version stamp (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Full first-launch install:
 *   1. Extract compiled draft binary from the .app bundle → ~/.draft/bin/draft
 *   2. Symlink ~/.draft/bin/draft → /usr/local/bin/draft
 *   3. For each selected tool: run `draft add <tool>`
 *
 * In dev mode (no bundled binary), falls back to calling `draft` from PATH.
 */
export async function runInstall(
  tools: InstallableTool[],
  appVersion?: string,
): Promise<InstallResult> {
  const steps: InstallStep[] = [];
  log(`runInstall called — tools: ${JSON.stringify(tools)}`);

  const resolvedVersion = appVersion ?? (await resolveAppVersion());

  // ── Step 1: Extract binary ───────────────────────────────────────────────────
  const draftBin = await extractBinary(steps, resolvedVersion);
  log(`extractBinary result — draftBin: ${draftBin ?? "null (dev mode)"}`);

  // ── Step 2: Symlink to /usr/local/bin ────────────────────────────────────────
  if (draftBin) {
    await symlinkBinary(draftBin, steps);
    log(`symlinkBinary done`);
  }

  // ── Step 3: Install selected tools ───────────────────────────────────────────
  for (const tool of tools) {
    log(`installTool starting — tool: ${tool}`);
    await installTool(tool, draftBin, steps);
    log(`installTool done — tool: ${tool}`);
  }

  const ok = steps.every((s) => s.ok);

  for (const step of steps) {
    if (!step.ok) {
      log(`✕ ${step.label}: ${step.error ?? "unknown error"}`);
    } else {
      log(`✓ ${step.label}`);
    }
  }

  log(`runInstall complete — ok: ${ok}, steps: ${steps.length}`);
  return { ok, steps };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function extractBinary(steps: InstallStep[], appVersion: string | null): Promise<string | null> {
  const bundledBin = getBundledBinPath();

  if (!bundledBin) {
    // Dev mode — binary not bundled; assume `draft` is already in PATH via install.sh
    steps.push({ label: "Locate draft binary", ok: true });
    return null;
  }

  if (!existsSync(bundledBin)) {
    steps.push({
      label: "Extract draft binary",
      ok: false,
      error: `Bundled binary not found at ${bundledBin}`,
    });
    return null;
  }

  try {
    mkdirSync(DRAFT_BIN_DIR, { recursive: true });
    copyFileSync(bundledBin, DRAFT_BIN_PATH);
    chmodSync(DRAFT_BIN_PATH, 0o755);
    steps.push({ label: "Extract draft binary", ok: true });
  } catch (err) {
    steps.push({
      label: "Extract draft binary",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // Extract bundled bun runtime — non-fatal; Slack capture degrades gracefully if missing
  const bundledBun = getBundledBunPath();
  if (bundledBun && existsSync(bundledBun)) {
    try {
      copyFileSync(bundledBun, `${DRAFT_BIN_DIR}/bun`);
      chmodSync(`${DRAFT_BIN_DIR}/bun`, 0o755);
      log(`bun runtime extracted to ${DRAFT_BIN_DIR}/bun`);
    } catch (err) {
      log(`bun extract failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log(`bundled bun not found (dev build or postbuild skipped) — Slack capture requires user-installed bun`);
  }

  // Extract bundled tmux binary — non-fatal; session monitoring degrades gracefully if missing
  const bundledTmux = getBundledTmuxPath();
  if (bundledTmux && existsSync(bundledTmux)) {
    try {
      copyFileSync(bundledTmux, `${DRAFT_BIN_DIR}/tmux`);
      chmodSync(`${DRAFT_BIN_DIR}/tmux`, 0o755);
      log(`tmux extracted to ${DRAFT_BIN_DIR}/tmux`);
    } catch (err) {
      log(`tmux extract failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log(`bundled tmux not found (dev build or prebuild skipped) — session monitoring requires user-installed tmux`);
  }

  // Stamp the version we just extracted from, so a fresh onboard starts in
  // sync and syncExtractedBins() doesn't immediately re-copy on next launch.
  if (appVersion) writeBinVersionStamp(appVersion);

  return DRAFT_BIN_PATH;
}

/**
 * Keep ~/.draft/bin's copies of draft/bun/tmux in lockstep with the running
 * app version. Self-update replaces the .app bundle but never re-runs
 * extractBinary(), so without this, already-onboarded users keep stale
 * (and potentially broken) binaries in ~/.draft/bin forever — notably a
 * stale tmux that shadows the user's own working tmux on PATH.
 *
 * Called on every launch (see index.ts syncBundledAssets). No-ops if the
 * user hasn't onboarded yet (~/.draft/bin doesn't exist — onboarding will
 * do the initial extraction) or if we're already stamped at appVersion.
 */
export async function syncExtractedBins(appVersion: string): Promise<void> {
  if (!existsSync(DRAFT_BIN_DIR)) {
    // Not onboarded yet — nothing to keep in sync.
    return;
  }

  const stampedVersion = existsSync(BIN_VERSION_STAMP)
    ? readFileSync(BIN_VERSION_STAMP, "utf8").trim()
    : null;

  if (stampedVersion === appVersion) {
    // Already in sync.
    return;
  }

  const targets: Array<{ label: string; bundled: string | null; dest: string }> = [
    { label: "draft", bundled: getBundledBinPath(),  dest: `${DRAFT_BIN_DIR}/draft` },
    { label: "bun",   bundled: getBundledBunPath(),  dest: `${DRAFT_BIN_DIR}/bun` },
    { label: "tmux",  bundled: getBundledTmuxPath(), dest: `${DRAFT_BIN_DIR}/tmux` },
  ];

  let copied = 0;
  let failed  = 0;
  for (const { label, bundled, dest } of targets) {
    if (!bundled || !existsSync(bundled)) {
      // Dev mode (no bundled binary) or bundling was skipped for this build.
      continue;
    }
    try {
      copyFileSync(bundled, dest);
      chmodSync(dest, 0o755);
      log(`synced ${label} to ${appVersion} at ${dest}`);
      copied++;
    } catch (err) {
      // e.g. ETXTBSY if the binary is executing right now. Non-fatal.
      log(`${label} sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }
  }

  // Stamp only when every binary we attempted succeeded. Stamping after a
  // partial failure would pin the version and leave the failed binary stale
  // until the next release; leaving it unstamped just retries next launch.
  if (copied > 0 && failed === 0) writeBinVersionStamp(appVersion);
}

async function symlinkBinary(draftBin: string, steps: InstallStep[]): Promise<void> {
  try {
    // Create /usr/local/bin if it doesn't exist (rare but possible)
    mkdirSync("/usr/local/bin", { recursive: true });

    // Remove stale symlink / old file if present
    if (existsSync(SYSTEM_LINK)) {
      unlinkSync(SYSTEM_LINK);
    }

    symlinkSync(draftBin, SYSTEM_LINK);
    steps.push({ label: "Add draft to PATH (/usr/local/bin)", ok: true });
  } catch (err) {
    // /usr/local/bin requires elevated permissions on most user machines.
    // Fall back to appending to the user's shell profile — the same pattern
    // used by Cargo, nvm, and Homebrew. Takes effect in new terminal sessions.
    const HOME = process.env.HOME!;
    const shell = process.env.SHELL ?? "/bin/zsh";
    const profile = shell.includes("zsh")  ? join(HOME, ".zprofile")
                  : shell.includes("bash") ? join(HOME, ".bash_profile")
                  :                          join(HOME, ".profile");
    const exportLine = `\nexport PATH="$HOME/.draft/bin:$PATH"  # added by Draft\n`;
    try {
      const existing = existsSync(profile) ? readFileSync(profile, "utf8") : "";
      if (!existing.includes(".draft/bin")) {
        appendFileSync(profile, exportLine);
      }
      steps.push({
        label: `Add draft to PATH (${profile.replace(HOME, "~")} — open a new terminal to activate)`,
        ok: true,
      });
    } catch (profileErr) {
      steps.push({
        label: "Add draft to PATH",
        ok: false,
        error: `Could not write to ${profile}. Run manually: echo 'export PATH="$HOME/.draft/bin:$PATH"' >> ${profile}`,
      });
    }
  }
}

async function installTool(
  tool: InstallableTool,
  draftBin: string | null,
  steps: InstallStep[],
): Promise<void> {
  // Resolve which binary to use: extracted from bundle, or fall back to PATH
  const bin = draftBin ?? "draft";
  log(`capture starting — cmd: [${bin}, add, ${tool}]`);

  // In bundle mode, the compiled `draft` binary can't walk up import.meta.dir
  // to find the repo root (it's a Bun virtual path, not a real filesystem path).
  // Pass the bundled asset dirs explicitly so add.ts can skip getRepoRoot().
  const env: Record<string, string> | undefined = draftBin
    ? {
        DRAFT_BACKGROUND_DIR: getBundledBackgroundDir(),
        DRAFT_PLUGIN_ROOT:    getBundledPluginDir(),
      }
    : undefined;
  if (env) {
    log(`  env: DRAFT_BACKGROUND_DIR=${env.DRAFT_BACKGROUND_DIR}`);
    log(`  env: DRAFT_PLUGIN_ROOT=${env.DRAFT_PLUGIN_ROOT}`);
  }

  const label = toolLabel(tool);
  try {
    const startMs = Date.now();
    const result = await capture([bin, "add", tool], { env, timeoutMs: 25_000 });
    const elapsedMs = Date.now() - startMs;
    log(`capture done — tool: ${tool}, exitCode: ${result.exitCode}, elapsed: ${elapsedMs}ms`);
    if (result.stdout) log(`  stdout: ${result.stdout.slice(0, 500)}`);
    if (result.stderr) log(`  stderr: ${result.stderr.slice(0, 500)}`);
    if (result.exitCode === 0) {
      steps.push({ label, ok: true });
    } else {
      steps.push({
        label,
        ok: false,
        error: result.stderr.trim() || `draft add ${tool} exited with code ${result.exitCode}`,
      });
    }
  } catch (err) {
    log(`capture threw — tool: ${tool}, err: ${err instanceof Error ? err.message : String(err)}`);
    steps.push({
      label,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function toolLabel(tool: InstallableTool): string {
  switch (tool) {
    case "claude-code": return "Install Claude Code plugin";
    case "codex":       return "Install Codex plugin";
    case "cursor":      return "Install Cursor plugin";
    case "openclaw":    return "Install OpenClaw plugin";
    case "hermes":      return "Install Hermes plugin";
  }
}

/**
 * Quick check for the onboarding wizard: is the system already installed?
 * Returns true when the daemon plist exists (background/install.sh has run).
 */
export function isAlreadyInstalled(): boolean {
  const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.draft.daemon.plist`;
  return existsSync(plistPath);
}
