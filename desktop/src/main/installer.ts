// desktop/src/main/installer.ts — first-launch installer for Draft.app
//
// Called from the onboarding wizard when appState.userState === "first-run".
// Extracts the bundled draft binary, symlinks it to /usr/local/bin/draft,
// then delegates all tool installs to `draft add <tool>` (single source of truth).
//
// Idempotent — safe to call if partially or fully installed.

import { existsSync, mkdirSync, copyFileSync, chmodSync, symlinkSync, unlinkSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { getBundledBinPath, getBundledBackgroundDir, getBundledPluginDir } from "./bundlePath";
import { capture } from "draft-core/exec";

const LOG_FILE = `${process.env.HOME}/.draft/logs/desktop-installer.log`;

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] [installer] ${msg}\n`;
  console.log(line.trimEnd());
  try {
    mkdirSync(`${process.env.HOME}/.draft/logs`, { recursive: true });
    appendFileSync(LOG_FILE, line);
  } catch { /* non-fatal */ }
}

export type InstallableTool = "claude-code" | "codex" | "cursor";

export interface InstallStep {
  label: string;
  ok: boolean;
  error?: string;
}

export interface InstallResult {
  ok: boolean;
  steps: InstallStep[];
}

const DRAFT_BIN_DIR  = `${process.env.HOME}/.draft/bin`;
const DRAFT_BIN_PATH = `${DRAFT_BIN_DIR}/draft`;
const SYSTEM_LINK    = "/usr/local/bin/draft";

/**
 * Full first-launch install:
 *   1. Extract compiled draft binary from the .app bundle → ~/.draft/bin/draft
 *   2. Symlink ~/.draft/bin/draft → /usr/local/bin/draft
 *   3. For each selected tool: run `draft add <tool>`
 *
 * In dev mode (no bundled binary), falls back to calling `draft` from PATH.
 */
export async function runInstall(tools: InstallableTool[]): Promise<InstallResult> {
  const steps: InstallStep[] = [];
  log(`runInstall called — tools: ${JSON.stringify(tools)}`);

  // ── Step 1: Extract binary ───────────────────────────────────────────────────
  const draftBin = await extractBinary(steps);
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

async function extractBinary(steps: InstallStep[]): Promise<string | null> {
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
    return DRAFT_BIN_PATH;
  } catch (err) {
    steps.push({
      label: "Extract draft binary",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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
