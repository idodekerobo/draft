// desktop/src/main/installer.ts — first-launch installer for Draft.app
//
// Called from the onboarding wizard when appState.userState === "no-profile".
// Extracts the bundled draft binary and symlinks it to /usr/local/bin/draft.
//
// `draft add <tool>` is no longer invoked automatically here — as of the
// Stage 2 CLI rebuild it only configures a project-local instruction file
// (CLAUDE.md/AGENTS.md/HERMES.md) and requires an explicit --dir, so it has
// nothing useful to do at desktop first-launch time. What (if anything)
// replaces the old plugin/skill/daemon install step this used to trigger is
// an open desktop-architecture question, tracked separately — not decided
// here. See TODOS.md.
//
// Idempotent — safe to call if partially or fully installed.

import { existsSync, mkdirSync, copyFileSync, chmodSync, symlinkSync, unlinkSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import Electrobun from "electrobun/bun";
import { getBundledBinPath, getBundledBunPath, getBundledTmuxPath } from "./bundlePath";

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

export interface BuildIdentity {
  /** `version:hash` — the key ~/.draft/bin's contents are stamped against. */
  buildId: string;
  /** Electrobun reports hash="dev" for every local dev build; see syncExtractedBins. */
  isDevChannel: boolean;
}

/**
 * Best-effort resolution of the running build's identity, for stamping
 * ~/.draft/bin/.version. Returns null in dev mode or on any failure
 * (matches the try/catch pattern index.ts uses around the same call).
 *
 * Keyed on version:hash rather than version alone for the same reason
 * syncBundledAssets() is — two builds can share a version string (a
 * same-version rebuild, or a hotfix cut without a bump), and the first one
 * to stamp would otherwise mask the second's binaries forever.
 */
async function resolveBuildIdentity(): Promise<BuildIdentity | null> {
  try {
    const info = await Electrobun.Updater.getLocalInfo();
    if (!info?.version) return null;
    return { buildId: `${info.version}:${info.hash}`, isDevChannel: info.channel === "dev" };
  } catch {
    return null;
  }
}

/**
 * Record the build ~/.draft/bin was last extracted/synced from.
 * Best-effort — a failed write just means we re-copy on the next launch.
 */
function writeBinVersionStamp(buildId: string): void {
  try {
    mkdirSync(DRAFT_BIN_DIR, { recursive: true });
    writeFileSync(BIN_VERSION_STAMP, buildId);
  } catch (err) {
    log(`failed to write bin version stamp (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * First-launch install:
 *   1. Extract compiled draft binary from the .app bundle → ~/.draft/bin/draft
 *   2. Symlink ~/.draft/bin/draft → /usr/local/bin/draft
 *
 * `tools` is accepted for caller compatibility but no longer drives a
 * `draft add <tool>` step — see the file header note.
 *
 * In dev mode (no bundled binary), falls back to calling `draft` from PATH.
 */
export async function runInstall(
  tools: InstallableTool[],
  buildId?: string,
): Promise<InstallResult> {
  const steps: InstallStep[] = [];
  log(`runInstall called — tools: ${JSON.stringify(tools)} (tool install step is currently a no-op)`);

  const resolvedBuildId = buildId ?? (await resolveBuildIdentity())?.buildId ?? null;

  // ── Step 1: Extract binary ───────────────────────────────────────────────────
  const draftBin = await extractBinary(steps, resolvedBuildId);
  log(`extractBinary result — draftBin: ${draftBin ?? "null (dev mode)"}`);

  // ── Step 2: Symlink to /usr/local/bin ────────────────────────────────────────
  if (draftBin) {
    await symlinkBinary(draftBin, steps);
    log(`symlinkBinary done`);
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

async function extractBinary(steps: InstallStep[], buildId: string | null): Promise<string | null> {
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

  // Stamp the build we just extracted from, so a fresh onboard starts in
  // sync and syncExtractedBins() doesn't immediately re-copy on next launch.
  if (buildId) writeBinVersionStamp(buildId);

  return DRAFT_BIN_PATH;
}

/**
 * Keep ~/.draft/bin's copies of draft/bun/tmux in lockstep with the running
 * build. Self-update replaces the .app bundle but never re-runs
 * extractBinary(), so without this, already-onboarded users keep stale
 * (and potentially broken) binaries in ~/.draft/bin forever — notably a
 * stale tmux that shadows the user's own working tmux on PATH.
 *
 * Called on every launch (see index.ts syncBundledAssets). No-ops if the
 * user hasn't onboarded yet (~/.draft/bin doesn't exist — onboarding will
 * do the initial extraction) or if we're already stamped at buildId.
 */
export async function syncExtractedBins(buildId: string, isDevChannel = false): Promise<void> {
  if (!existsSync(DRAFT_BIN_DIR)) {
    // Not onboarded yet — nothing to keep in sync.
    return;
  }

  const stampedBuildId = existsSync(BIN_VERSION_STAMP)
    ? readFileSync(BIN_VERSION_STAMP, "utf8").trim()
    : null;

  // Electrobun reports hash="dev" for every local dev build, so the buildId
  // can't distinguish two of them — always re-copy there rather than let an
  // earlier dev build's stamp mask a later one. Same reasoning (and the same
  // "it's only a few file copies" tradeoff) as syncBundledAssets in index.ts.
  if (!isDevChannel && stampedBuildId === buildId) {
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
      log(`synced ${label} to ${buildId} at ${dest}`);
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
  if (copied > 0 && failed === 0) writeBinVersionStamp(buildId);
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

/**
 * Quick check for the onboarding wizard: is the system already installed?
 * Returns true when the daemon plist exists (background/install.sh has run).
 */
export function isAlreadyInstalled(): boolean {
  const plistPath = `${process.env.HOME}/Library/LaunchAgents/com.draft.daemon.plist`;
  return existsSync(plistPath);
}
