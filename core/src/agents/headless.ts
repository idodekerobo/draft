// core/src/agents/headless.ts — shared headless CLI agent spawner
//
// Used by: draft-desktop (RPC handler), draft-cli (future)
//
// Fire-and-forget: resolves immediately after spawning, then drives onProgress
// callbacks as phases change. If the runner is missing or spawn fails, resolves
// with { ok: false } before any async work starts.

import { join } from "path";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { capture } from "../exec";
import { DRAFT_ROOT } from "../config";

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

export async function spawnHeadlessAgent(
  opts: SpawnHeadlessAgentOpts,
): Promise<SpawnHeadlessAgentResult> {
  const runner = opts.runner ?? "claude";
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const notify = opts.onProgress ?? (() => {});
  const runnerName = runner === "claude" ? "Claude Code" : "Codex";

  const which = await capture(["which", runner]);
  if (which.exitCode !== 0) {
    return { ok: false, error: `${runnerName} CLI not found. Install it first or run /draft-setup manually.` };
  }

  const tmpDir = join(DRAFT_ROOT, "tmp");
  const promptPath = join(tmpDir, `headless-${Date.now()}.md`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(promptPath, opts.prompt, "utf8");
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not write prompt file." };
  }

  const cliCmd = runner === "codex"
    ? ["codex", "exec", "--skip-git-repo-check", "-"]
    : ["claude", "-p", "-"];

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cliCmd, {
      stdin: Bun.file(promptPath),
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    try { unlinkSync(promptPath); } catch {}
    return { ok: false, error: err instanceof Error ? err.message : `Could not start ${runnerName}.` };
  }

  notify({ phase: "starting", label: `Starting ${runnerName}…` });

  const writingTimer = setTimeout(() => {
    notify({ phase: "writing", label: "Writing workspace files…" });
  }, 10_000);

  const timeoutTimer = setTimeout(() => {
    proc.kill();
    notify({ phase: "error", label: "Context setup is taking too long.", error: "timeout" });
  }, timeoutMs);

  void (async () => {
    try {
      const [exitCode, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      ]);
      clearTimeout(writingTimer);
      clearTimeout(timeoutTimer);

      if (exitCode === 0) {
        notify({ phase: "complete", label: "Context setup complete." });
      } else {
        notify({ phase: "error", label: classifyStderr(stderr), error: stderr || `Exited with code ${exitCode}.` });
      }
    } finally {
      try { unlinkSync(promptPath); } catch {}
    }
  })();

  notify({ phase: "running", label: "Setting up context…" });
  return { ok: true };
}

function classifyStderr(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("auth") || s.includes("login")) return "Your session expired. Sign in and try again.";
  if (s.includes("rate") || s.includes("429")) return "Rate limited. Wait a moment and try again.";
  if (s.includes("token") || s.includes("context length") || s.includes("too long")) return "Too much content to process at once. Try with a smaller folder.";
  if (s.includes("network") || s.includes("connect") || s.includes("econnrefused") || s.includes("dns")) return "Network error. Check your connection and try again.";
  return "Something went wrong. You can retry or set up context manually.";
}
