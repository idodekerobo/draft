// background/synthesize.ts — Draft synthesis router
//
// Reads a job file, checks eligibility, delegates to the source adapter bash script,
// handles timeout, and writes output to proposals/.
// Job file cleanup (unlinkSync/renameSync) is the caller's responsibility.
// DB writes are added in T3 after the core/src/db/ module exists.

import { BACKGROUND_DIR, getWorkspacePath } from 'draft-core/config';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from 'fs';
import { join } from 'path';

export interface SynthesizeResult {
  status: 'success' | 'failed' | 'skipped' | 'timeout';
  proposalsGenerated: number; // always 0 in T1; real counting added in T3
  errorMsg?: string;
  skipReason?: string;
}

interface Job {
  session_id?: string;
  reason?: string;
  profile?: string;
  source?: string;
  cwd?: string;
}

const LOGS_DIR   = `${BACKGROUND_DIR}/logs`;
const LOG_PATH   = `${LOGS_DIR}/daemon.log`;
const TIMEOUT_MS = 300_000;

function slog(level: 'info' | 'warn' | 'error', msg: string) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n';
  try { appendFileSync(LOG_PATH, line); } catch {}
}

export async function synthesize(jobPath: string): Promise<SynthesizeResult> {
  // ── Parse job ──────────────────────────────────────────────────────────────
  let job: Job;
  try {
    job = JSON.parse(await Bun.file(jobPath).text()) as Job;
  } catch {
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid job JSON' };
  }

  const profile      = job.profile    ?? 'default';
  const sessionId    = job.session_id ?? 'unknown';
  const reason       = job.reason     ?? 'unknown';
  const source       = job.source     ?? 'claude-code-session';
  const sessionShort = sessionId.slice(0, 8);

  // ── Skip non-clean exits ───────────────────────────────────────────────────
  // reason != 'prompt_input_exit' means crash, force-kill, or other abnormal exit.
  // Transcript may be incomplete — skip synthesis to avoid noise.
  if (reason !== 'prompt_input_exit') {
    slog('info', `synthesize: skipping job (reason=${reason} session=${sessionShort} profile=${profile})`);
    return { status: 'skipped', proposalsGenerated: 0, skipReason: reason };
  }

  slog('info', `synthesize: starting (session=${sessionShort} profile=${profile})`);

  // ── Resolve adapter script ─────────────────────────────────────────────────
  const adapterScript = join(BACKGROUND_DIR, 'synthesizers', `${source}.sh`);
  if (!existsSync(adapterScript)) {
    const msg = `source adapter not found: ${adapterScript} (session=${sessionShort})`;
    slog('error', `synthesize: ${msg}`);
    return { status: 'failed', proposalsGenerated: 0, errorMsg: msg };
  }

  // ── Spawn adapter with 300s timeout ───────────────────────────────────────
  mkdirSync(LOGS_DIR, { recursive: true });
  const logFd = openSync(LOG_PATH, 'a');

  const proc = Bun.spawn(['bash', adapterScript, jobPath], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: logFd,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // Kill process group so grandchildren (e.g. `claude -p` inside the adapter) are cleaned up
    if (proc.pid) {
      try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
    }
    proc.kill();
  }, TIMEOUT_MS);

  const [exitCode, stdoutText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  clearTimeout(timer);
  closeSync(logFd);

  if (timedOut) {
    slog('error', `synthesize: timeout after 300s (session=${sessionShort})`);
    return { status: 'timeout', proposalsGenerated: 0, errorMsg: 'timed out after 300s' };
  }

  if (exitCode !== 0) {
    slog('error', `synthesize: adapter exited ${exitCode} (session=${sessionShort})`);
    return { status: 'failed', proposalsGenerated: 0, errorMsg: `adapter exited ${exitCode}` };
  }

  // ── Validate output ────────────────────────────────────────────────────────
  if (!stdoutText.trim()) {
    slog('warn', `synthesize: empty output from adapter (session=${sessionShort}) — nothing to stage`);
    return { status: 'success', proposalsGenerated: 0 };
  }

  if (stdoutText.includes('context_updates: []')) {
    slog('info', `synthesize: no team-relevant updates found (session=${sessionShort})`);
    return { status: 'success', proposalsGenerated: 0 };
  }

  // ── Write to proposals/ ────────────────────────────────────────────────────
  const workspace  = getWorkspacePath(profile);
  const stagingDir = join(workspace, 'proposals');
  mkdirSync(join(stagingDir, 'accepted'), { recursive: true });
  mkdirSync(join(stagingDir, 'rejected'), { recursive: true });

  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const ts  = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
              `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const stagingFile = join(stagingDir, `${ts}-${sessionShort}.md`);

  await Bun.write(stagingFile, stdoutText);
  slog('info', `synthesize: staged at ${stagingFile} (session=${sessionShort} profile=${profile})`);

  return { status: 'success', proposalsGenerated: 0 };
}
