// background/synthesize.ts — Draft synthesis router
//
// Reads a job file, checks eligibility, delegates to the source adapter bash script,
// handles timeout, writes output to proposals/, and records the run in activity.db.
// Job file cleanup (unlinkSync/renameSync) is the caller's responsibility.

import { openActivityDb, insertRun, type ActivityRun } from 'draft-core/db/activity';
import { BACKGROUND_DIR, getWorkspacePath } from 'draft-core/config';
import { validateAutomatedSynthesisOutput } from 'draft-core/proposals';
import { resolveRuntimeEntrypoint, runtimeCommand } from 'draft-core/runtime';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from 'fs';
import { basename, join } from 'path';

export interface SynthesizeResult {
  status: 'success' | 'failed' | 'skipped' | 'timeout';
  proposalsGenerated: number;
  errorMsg?: string;
  skipReason?: string;
}

interface Job {
  job_id?: string;
  session_id?: string;
  reason?: string;
  profile?: string;
  source?: string;
  cwd?: string;
  transcript_path?: string;
  transcript_fingerprint?: string;
}

const SYNTHESIS_ADAPTERS = {
  github: 'github',
  slack: 'slack',
  granola: 'granola',
  'claude-code-session': 'claude-code-session',
  'codex-session': 'codex-session',
} as const;

type SynthesisSource = keyof typeof SYNTHESIS_ADAPTERS;

function isSynthesisSource(value: unknown): value is SynthesisSource {
  return typeof value === 'string' && Object.hasOwn(SYNTHESIS_ADAPTERS, value);
}

const LOGS_DIR   = `${BACKGROUND_DIR}/logs`;
const LOG_PATH   = `${LOGS_DIR}/daemon.log`;
const TIMEOUT_MS = 300_000;

function slog(level: 'info' | 'warn' | 'error', msg: string) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n';
  try { appendFileSync(LOG_PATH, line); } catch {}
}

function countProposalFiles(stagingDir: string): number {
  try {
    return readdirSync(stagingDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith('.md'))
      .length;
  } catch {
    return 0; // ENOENT or unreadable — treat as empty
  }
}

function writeActivityRow(workspace: string, run: ActivityRun): void {
  try {
    mkdirSync(workspace, { recursive: true });
    const db = openActivityDb(workspace);
    insertRun(db, run);
    db.close();
  } catch (e) {
    slog('warn', `synthesize: failed to write activity row: ${e}`);
  }
}

export async function synthesize(jobPath: string): Promise<SynthesizeResult> {
  const startedAt = new Date().toISOString();
  const startTime = Date.now();
  // Job UUID from filename — used as row id so duplicate job runs are idempotent
  const fallbackJobId = basename(jobPath).replace(/^job-/, '').replace(/\.json$/, '');

  // ── Parse job ──────────────────────────────────────────────────────────────
  let job: Job;
  try {
    job = JSON.parse(await Bun.file(jobPath).text()) as Job;
  } catch {
    // Can't determine profile — no DB write
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid job JSON' };
  }

  const profile        = job.profile         ?? 'default';
  const jobId          = job.job_id          ?? fallbackJobId;
  const sessionId      = job.session_id      ?? null;
  const reason         = job.reason          ?? 'unknown';
  const rawSource      = job.source          ?? 'claude-code-session';
  if (!isSynthesisSource(rawSource)) {
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid synthesis source' };
  }
  const source         = rawSource;
  const cwd            = job.cwd             ?? null;
  const transcriptPath: string | null = job.transcript_path ?? null;
  const sessionShort   = sessionId ? sessionId.slice(0, 8) : 'unknown';
  const workspace      = getWorkspacePath(profile);

  // ── Skip exits that indicate broken/missing transcripts ─────────────────────
  // 'other' (Ctrl+C) and 'prompt_input_exit' (clean exit) both have usable
  // transcripts. Skip only reasons where synthesis would produce noise.
  const SKIP_REASONS = new Set(['clear', 'resume', 'logout', 'bypass_permissions_disabled']);
  if (SKIP_REASONS.has(reason)) {
    slog('info', `synthesize: skipping job (reason=${reason} session=${sessionShort} profile=${profile})`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd, transcriptPath,
      startedAt, endedAt: new Date().toISOString(), status: 'skipped',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: reason, errorMsg: null,
    });
    return { status: 'skipped', proposalsGenerated: 0, skipReason: reason };
  }

  // ── Skip missing transcripts before spawning the expensive adapter ─────────
  // Session-source jobs require a transcript file. Check early to avoid launching
  // a Claude session that will immediately fail.
  if (source === 'claude-code-session' || source === 'codex-session') {
    if (!transcriptPath || !existsSync(transcriptPath)) {
      const why = !transcriptPath ? 'missing_transcript_path' : 'missing_transcript';
      slog('info', `synthesize: skipping job (${why} session=${sessionShort} profile=${profile})`);
      writeActivityRow(workspace, {
        id: jobId, profile, source, sessionId, cwd, transcriptPath,
        startedAt, endedAt: new Date().toISOString(), status: 'skipped',
        durationMs: Date.now() - startTime,
        proposalsGenerated: 0, skipReason: why, errorMsg: null,
      });
      return { status: 'skipped', proposalsGenerated: 0, skipReason: why };
    }
  }

  // Codex transcripts remain writable while a session is active. A scanner job
  // carries the fingerprint it observed; if the file changed before processing,
  // defer it so the scanner can wait for the new version to stabilize.
  if (source === 'codex-session' && transcriptPath && job.transcript_fingerprint) {
    const stat = statSync(transcriptPath);
    const currentFingerprint = `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
    if (currentFingerprint !== job.transcript_fingerprint) {
      const why = 'transcript_changed';
      slog('info', `synthesize: skipping job (${why} session=${sessionShort} profile=${profile})`);
      writeActivityRow(workspace, {
        id: jobId, profile, source, sessionId, cwd, transcriptPath,
        startedAt, endedAt: new Date().toISOString(), status: 'skipped',
        durationMs: Date.now() - startTime,
        proposalsGenerated: 0, skipReason: why, errorMsg: null,
      });
      return { status: 'skipped', proposalsGenerated: 0, skipReason: why };
    }
  }

  slog('info', `synthesize: starting (session=${sessionShort} profile=${profile})`);

  // ── Resolve adapter script (bundled .js, then source .ts, then .sh) ───────
  const adapter = resolveRuntimeEntrypoint(
    join(BACKGROUND_DIR, 'synthesizers', SYNTHESIS_ADAPTERS[source]),
  );
  if (!adapter) {
    const msg = `source adapter not found for "${source}" (tried .js, .ts, and .sh; session=${sessionShort})`;
    slog('error', `synthesize: ${msg}`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd, transcriptPath,
      startedAt, endedAt: new Date().toISOString(), status: 'failed',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg: msg,
    });
    return { status: 'failed', proposalsGenerated: 0, errorMsg: msg };
  }

  const adapterCmd = runtimeCommand(adapter, [jobPath]);
  if (!adapterCmd) {
    const msg = `bun runtime not found for source adapter "${source}"`;
    slog('error', `synthesize: ${msg}`);
    return { status: 'failed', proposalsGenerated: 0, errorMsg: msg };
  }

  // ── Count proposals before spawn (ENOENT-safe) ────────────────────────────
  const stagingDir  = join(workspace, 'proposals');
  const countBefore = countProposalFiles(stagingDir);

  // ── Spawn adapter with 300s timeout ───────────────────────────────────────
  mkdirSync(LOGS_DIR, { recursive: true });
  const logFd = openSync(LOG_PATH, 'a');

  const proc = Bun.spawn(adapterCmd, {
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
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd, transcriptPath,
      startedAt, endedAt: new Date().toISOString(), status: 'timeout',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg: 'timed out after 300s',
    });
    return { status: 'timeout', proposalsGenerated: 0, errorMsg: 'timed out after 300s' };
  }

  if (exitCode !== 0) {
    const errorMsg = `adapter exited ${exitCode}`;
    slog('error', `synthesize: ${errorMsg} (session=${sessionShort})`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd, transcriptPath,
      startedAt, endedAt: new Date().toISOString(), status: 'failed',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg,
    });
    return { status: 'failed', proposalsGenerated: 0, errorMsg };
  }

  // ── Validate output ────────────────────────────────────────────────────────
  if (!stdoutText.trim()) {
    const why = 'empty output';
    slog('info', `synthesize: ${why} (session=${sessionShort}) — nothing to stage`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd, transcriptPath,
      startedAt, endedAt: new Date().toISOString(), status: 'success',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg: null,
    });
    return { status: 'success', proposalsGenerated: 0 };
  }

  const validation = validateAutomatedSynthesisOutput(stdoutText);
  if (!validation.ok) {
    const errorMsg = `invalid automated synthesis output: ${validation.error}`;
    slog('error', `synthesize: ${errorMsg} (source=${source} session=${sessionShort})`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd, transcriptPath,
      startedAt, endedAt: new Date().toISOString(), status: 'failed',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg,
    });
    return { status: 'failed', proposalsGenerated: 0, errorMsg };
  }
  if (!validation.updates.length) {
    slog('info', `synthesize: no team-relevant updates (session=${sessionShort}) — nothing to stage`);
    writeActivityRow(workspace, {
      id: jobId, profile, source, sessionId, cwd, transcriptPath,
      startedAt, endedAt: new Date().toISOString(), status: 'success',
      durationMs: Date.now() - startTime,
      proposalsGenerated: 0, skipReason: null, errorMsg: null,
    });
    return { status: 'success', proposalsGenerated: 0 };
  }

  // ── Write to proposals/ ────────────────────────────────────────────────────
  mkdirSync(join(stagingDir, 'accepted'), { recursive: true });
  mkdirSync(join(stagingDir, 'rejected'), { recursive: true });

  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const ts  = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
              `T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const nonSessionSuffix = `${source}-${jobId}`
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'job';
  const proposalSuffix = sessionId ? sessionShort : nonSessionSuffix;
  const stagingFile = join(stagingDir, `${ts}-${proposalSuffix}.md`);

  await Bun.write(stagingFile, stdoutText);
  slog('info', `synthesize: staged at ${stagingFile} (session=${sessionShort} profile=${profile})`);

  // ── Record success row ─────────────────────────────────────────────────────
  const proposalsGenerated = Math.max(0, countProposalFiles(stagingDir) - countBefore);
  writeActivityRow(workspace, {
    id: jobId, profile, source, sessionId, cwd, transcriptPath,
    startedAt, endedAt: new Date().toISOString(), status: 'success',
    durationMs: Date.now() - startTime,
    proposalsGenerated, skipReason: null, errorMsg: null,
  });

  return { status: 'success', proposalsGenerated };
}

// ── CLI entrypoint ─────────────────────────────────────────────────────────────
if (import.meta.main) {
  void (async () => {
    const jobPath = process.argv[2];
    if (!jobPath) {
      console.error('Usage: bun synthesize.ts <job-path>');
      process.exit(1);
    }
    const result = await synthesize(jobPath);
    process.exit(result.status === 'failed' || result.status === 'timeout' ? 1 : 0);
  })();
}
