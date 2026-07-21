// core/src/agents/headless.ts — shared headless CLI agent spawner
//
// Used by: draft-desktop (RPC handler), draft-cli (future)
//
// Fire-and-forget: resolves immediately after spawning, then drives onProgress
// callbacks as phases change. If the runner is missing or spawn fails, resolves
// with { ok: false } before any async work starts.

import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, appendFileSync, unlinkSync, readdirSync } from "fs";
import { homedir, platform } from "os";
import { capture } from "../exec";
import { DRAFT_ROOT } from "../config";

const NOT_AUTHENTICATED_ERROR =
  "You're not signed in to Claude Code. Open a terminal, run `claude`, then `/login` to sign in — then retry context setup.";

const HEADLESS_LOG_DIR = join(DRAFT_ROOT, "logs", "headless");

export type HeadlessPhase = "starting" | "running" | "writing" | "complete" | "error";

export interface HeadlessProgress {
  phase: HeadlessPhase;
  label: string;
  error?: string;
}

export type HeadlessRunner = "claude" | "codex";

export interface SpawnHeadlessAgentOpts {
  runner?: HeadlessRunner;
  prompt: string;
  onProgress?: (progress: HeadlessProgress) => void;
  timeoutMs?: number;
}

export type SpawnHeadlessAgentResult =
  | { ok: true }
  | { ok: false; error: string };

export async function resolveRunnerBin(name: string): Promise<string | null> {
  const HOME = process.env.HOME ?? "";
  const knownPaths = [
    `${HOME}/.local/bin/${name}`,
    `/usr/local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `${HOME}/.npm-global/bin/${name}`,
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }
  const nvmDir = `${HOME}/.nvm/versions/node`;
  if (existsSync(nvmDir)) {
    try {
      for (const v of readdirSync(nvmDir).reverse()) {
        const p = `${nvmDir}/${v}/bin/${name}`;
        if (existsSync(p)) return p;
      }
    } catch {}
  }
  return null;
}

/**
 * Preflight only — checks whether Claude Code has *ever* logged in, not
 * whether that session is still valid. macOS stores the OAuth token in
 * Keychain; there's no local way to validate it without a network call, and
 * `spawnHeadlessAgent`'s stdout classification already catches expired
 * tokens on the real run. This exists to skip a doomed run entirely for the
 * common "never logged in" case, not to guarantee auth is good.
 */
export async function isClaudeAuthenticated(): Promise<boolean> {
  if (platform() === "darwin") {
    const result = await capture(["security", "find-generic-password", "-s", "Claude Code-credentials"]);
    return result.exitCode === 0;
  }
  return existsSync(join(homedir(), ".claude", ".credentials.json"));
}

export async function spawnHeadlessAgent(
  opts: SpawnHeadlessAgentOpts,
): Promise<SpawnHeadlessAgentResult> {
  const runner = opts.runner ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 1_500_000;
  const notify = opts.onProgress ?? (() => {});
  const runnerName = runner === "claude" ? "Claude Code" : "Codex";

  const runnerBin = await resolveRunnerBin(runner);
  if (!runnerBin) {
    return { ok: false, error: `${runnerName} CLI not found. Install it first or run /draft-setup manually.` };
  }

  // TODO(backlog): automate this via a detached tmux session that drives
  // `claude` → `/login`, scrapes the OAuth URL from the pane, opens it for
  // the user, and polls for success — deferred, tmux-scraping a TUI is
  // fragile and this manual path is the safe baseline (see decision 2026-07-21).
  if (runner === "claude" && !(await isClaudeAuthenticated())) {
    return { ok: false, error: NOT_AUTHENTICATED_ERROR };
  }

  const ts = Date.now();
  const tmpDir = join(DRAFT_ROOT, "tmp");
  const promptPath = join(tmpDir, `headless-${ts}.md`);
  const logPath = join(HEADLESS_LOG_DIR, `context-bootstrap-${ts}.log`);

  try {
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(HEADLESS_LOG_DIR, { recursive: true });
    writeFileSync(promptPath, opts.prompt, "utf8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not write prompt file." };
  }

  function log(line: string) {
    try { appendFileSync(logPath, line + "\n"); } catch {}
  }

  log(`[${new Date(ts).toISOString()}] runner=${runner} bin=${runnerBin}`);
  log(`--- prompt ---`);
  log(opts.prompt);
  log(`--- output ---`);

  const cliCmd = runner === "codex"
    ? [runnerBin, "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-"]
    : [runnerBin, "-p", "--dangerously-skip-permissions", "-"];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cliCmd, {
      stdin: Bun.file(promptPath),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    try { unlinkSync(promptPath); } catch {}
    const msg = err instanceof Error ? err.message : `Could not start ${runnerName}.`;
    log(`[spawn error] ${msg}`);
    return { ok: false, error: msg };
  }

  notify({ phase: "starting", label: `Starting ${runnerName}…` });

  const writingTimer = setTimeout(() => {
    notify({ phase: "writing", label: "Writing workspace files…" });
  }, 10_000);

  const timeoutTimer = setTimeout(() => {
    proc.kill();
    log(`[timeout] killed after ${timeoutMs}ms`);
    notify({ phase: "error", label: "Context setup is taking too long.", error: "timeout" });
  }, timeoutMs);

  void (async () => {
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      ]);
      clearTimeout(writingTimer);
      clearTimeout(timeoutTimer);

      if (stdout) log(stdout);
      if (stderr)  log(`--- stderr ---\n${stderr}`);
      log(`--- exit ${exitCode} ---`);

      if (exitCode === 0) {
        notify({ phase: "complete", label: "Context setup complete." });
      } else {
        const combinedOutput = `${stdout}\n${stderr}`;
        notify({ phase: "error", label: classifyOutput(combinedOutput), error: stderr || stdout || `Exited with code ${exitCode}.` });
      }
    } finally {
      try { unlinkSync(promptPath); } catch {}
    }
  })();

  notify({ phase: "running", label: "Setting up context…" });
  return { ok: true };
}

// Claude Code's `-p` CLI writes auth failures ("Not logged in · Please run
// /login", "Failed to authenticate. API Error: 401 ...") to stdout, not
// stderr — so this must check both. Confirmed from real failure logs where
// stderr was empty and the error text was in stdout.
export function classifyOutput(output: string): string {
  const s = output.toLowerCase();
  if (s.includes("not logged in") || s.includes("failed to authenticate") || s.includes("please run /login") || s.includes("401")) {
    return NOT_AUTHENTICATED_ERROR;
  }
  if (s.includes("auth") || s.includes("login")) return "Your session expired. Sign in and try again.";
  if (s.includes("rate") || s.includes("429")) return "Rate limited. Wait a moment and try again.";
  if (s.includes("token") || s.includes("context length") || s.includes("too long")) return "Too much content to process at once. Try with a smaller folder.";
  if (s.includes("network") || s.includes("connect") || s.includes("econnrefused") || s.includes("dns")) return "Network error. Check your connection and try again.";
  return "Something went wrong. You can retry or set up context manually.";
}
