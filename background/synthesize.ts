// background/synthesize.ts — Draft synthesis router
//
// Reads a job file, checks eligibility, delegates to the source adapter bash script,
// handles timeout, and routes validated output through the trusted maintainer.
// Job file cleanup (unlinkSync/renameSync) is the caller's responsibility.

import { BACKGROUND_DIR, getWorkspacePath } from 'draft-core/config';
import { resolveRuntimeEntrypoint, runtimeCommand } from 'draft-core/runtime';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'fs';
import { basename, join } from 'path';
import { routeAutomatedMaintainerOutput } from './automated-maintainer-router';

export interface SynthesizeResult {
  status: 'success' | 'failed' | 'skipped' | 'timeout' | 'deferred';
  proposalsGenerated: number;
  errorMsg?: string;
  skipReason?: string;
}

export interface SynthesizeAdapterResult {
  exitCode: number;
  stdoutText: string;
  timedOut?: boolean;
}

export interface SynthesizeDeps {
  getWorkspacePath?: (profile: string) => string;
  executeAdapter?: (input: {
    jobPath: string;
    source: SynthesisSource;
  }) => Promise<SynthesizeAdapterResult>;
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
  timestamp?: string;
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

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

const LOGS_DIR   = `${BACKGROUND_DIR}/logs`;
const LOG_PATH   = `${LOGS_DIR}/daemon.log`;
const TIMEOUT_MS = 300_000;

function slog(level: 'info' | 'warn' | 'error', msg: string) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n';
  try { appendFileSync(LOG_PATH, line); } catch {}
}

export async function synthesize(
  jobPath: string,
  deps: SynthesizeDeps = {},
): Promise<SynthesizeResult> {
  const startedAt = new Date().toISOString();
  // Job UUID from filename — used as the job id when the job file doesn't carry one
  const fallbackJobId = basename(jobPath).replace(/^job-/, '').replace(/\.json$/, '');

  // ── Parse job ──────────────────────────────────────────────────────────────
  let job: Job;
  try {
    job = JSON.parse(await Bun.file(jobPath).text()) as Job;
  } catch {
    // Can't determine profile — no DB write
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid job JSON' };
  }

  if (job.profile !== undefined && (
    !isBoundedString(job.profile, 255)
    || !/^[a-zA-Z0-9_-]+$/.test(job.profile)
  )) {
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid job profile' };
  }
  if (job.job_id !== undefined && !isBoundedString(job.job_id, 255)) {
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid job_id' };
  }
  if (job.session_id !== undefined && !isBoundedString(job.session_id, 255)) {
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid session_id' };
  }
  if (job.timestamp !== undefined && (
    !isBoundedString(job.timestamp, 64)
    || Number.isNaN(Date.parse(job.timestamp))
  )) {
    return { status: 'failed', proposalsGenerated: 0, errorMsg: 'invalid job timestamp' };
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
  const transcriptPath: string | null = job.transcript_path ?? null;
  const sessionShort   = sessionId ? sessionId.slice(0, 8) : 'unknown';
  const workspace      = (deps.getWorkspacePath ?? getWorkspacePath)(profile);

  // ── Skip exits that indicate broken/missing transcripts ─────────────────────
  // 'other' (Ctrl+C) and 'prompt_input_exit' (clean exit) both have usable
  // transcripts. Skip only reasons where synthesis would produce noise.
  const SKIP_REASONS = new Set(['clear', 'resume', 'logout', 'bypass_permissions_disabled']);
  if (SKIP_REASONS.has(reason)) {
    slog('info', `synthesize: skipping job (reason=${reason} session=${sessionShort} profile=${profile})`);
    return { status: 'skipped', proposalsGenerated: 0, skipReason: reason };
  }

  // ── Skip missing transcripts before spawning the expensive adapter ─────────
  // Session-source jobs require a transcript file. Check early to avoid launching
  // a Claude session that will immediately fail.
  if (source === 'claude-code-session' || source === 'codex-session') {
    if (!transcriptPath || !existsSync(transcriptPath)) {
      const why = !transcriptPath ? 'missing_transcript_path' : 'missing_transcript';
      slog('info', `synthesize: skipping job (${why} session=${sessionShort} profile=${profile})`);
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
      return { status: 'skipped', proposalsGenerated: 0, skipReason: why };
    }
  }

  slog('info', `synthesize: starting (session=${sessionShort} profile=${profile})`);

  let exitCode: number;
  let stdoutText: string;
  let timedOut = false;
  if (deps.executeAdapter) {
    ({ exitCode, stdoutText, timedOut = false } = await deps.executeAdapter({ jobPath, source }));
  } else {
    // ── Resolve adapter script (bundled .js, then source .ts, then .sh) ─────
    const adapter = resolveRuntimeEntrypoint(
      join(BACKGROUND_DIR, 'synthesizers', SYNTHESIS_ADAPTERS[source]),
    );
    if (!adapter) {
      const msg = `source adapter not found for "${source}" (tried .js, .ts, and .sh; session=${sessionShort})`;
      slog('error', `synthesize: ${msg}`);
      return { status: 'failed', proposalsGenerated: 0, errorMsg: msg };
    }

    const adapterCmd = runtimeCommand(adapter, [jobPath]);
    if (!adapterCmd) {
      const msg = `bun runtime not found for source adapter "${source}"`;
      slog('error', `synthesize: ${msg}`);
      return { status: 'failed', proposalsGenerated: 0, errorMsg: msg };
    }

    // ── Spawn adapter with 300s timeout ─────────────────────────────────────
    mkdirSync(LOGS_DIR, { recursive: true });
    const logFd = openSync(LOG_PATH, 'a');

    const proc = Bun.spawn(adapterCmd, {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: logFd,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill process group so grandchildren (e.g. `claude -p` inside the adapter) are cleaned up
      if (proc.pid) {
        try { process.kill(-proc.pid, 'SIGTERM'); } catch {}
      }
      proc.kill();
    }, TIMEOUT_MS);

    [exitCode, stdoutText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    clearTimeout(timer);
    closeSync(logFd);
  }

  if (timedOut) {
    slog('error', `synthesize: timeout after 300s (session=${sessionShort})`);
    return { status: 'timeout', proposalsGenerated: 0, errorMsg: 'timed out after 300s' };
  }

  if (exitCode !== 0) {
    const errorMsg = `adapter exited ${exitCode}`;
    slog('error', `synthesize: ${errorMsg} (session=${sessionShort})`);
    return { status: 'failed', proposalsGenerated: 0, errorMsg };
  }

  if (!stdoutText.trim()) {
    // A source adapter can legitimately produce nothing (e.g. a Codex transcript with
    // no conversation turns). That is a no-op run, not a contract violation.
    slog('info', `synthesize: empty output (session=${sessionShort}) — no changes`);
    return { status: 'success', proposalsGenerated: 0 };
  }

  // ── Validate and route through the automated maintainer ───────────────────
  let routed;
  try {
    const intelligence = source === 'granola'
      ? process.env.DRAFT_GRANOLA_INTELLIGENCE
      : source === 'slack'
        ? process.env.DRAFT_SLACK_INTELLIGENCE
        : source === 'github'
          ? process.env.DRAFT_GITHUB_INTELLIGENCE
          : process.env.DRAFT_SESSION_INTELLIGENCE;
    const inputSource = source === 'claude-code-session' || source === 'codex-session'
      ? 'session'
      : source;
    routed = routeAutomatedMaintainerOutput(stdoutText, {
      ...(sessionId ? { session_id: sessionId, job_id: jobId } : { job_id: jobId }),
      input_source: inputSource,
      synthesized_by: intelligence ?? 'claude-code',
      timestamp: job.timestamp ?? startedAt,
      profile,
    }, workspace);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    slog('error', `synthesize: ${errorMsg} (source=${source} session=${sessionShort})`);
    return { status: 'failed', proposalsGenerated: 0, errorMsg };
  }

  if (routed.status === 'locked') {
    // Another run holds the workspace writer: this job has not happened yet,
    // and the daemon will re-queue it.
    slog('info', `synthesize: workspace locked — deferring (session=${sessionShort})`);
    return { status: 'deferred', proposalsGenerated: 0 };
  }

  const proposalsGenerated = routed.status === 'flagged' ? 1 : 0;
  slog('info', `synthesize: ${routed.outcome} (session=${sessionShort} profile=${profile})`);

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
