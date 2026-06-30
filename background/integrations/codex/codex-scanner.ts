// background/integrations/codex/codex-scanner.ts — periodic Codex session scanner
//
// A transcript must be unchanged across two scans before it is queued. Jobs are
// considered complete only after the daemon removes them from the queue without
// leaving a failed file. Failed fingerprints retry with bounded backoff.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { BACKGROUND_DIR, getActiveProfile } from 'draft-core/config';

const EXPIRY_DAYS = 7;
const EXPIRY_MS = EXPIRY_DAYS * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

interface LegacySessionEntry {
  session_id: string;
  processed_at?: string;
  suppressed_at?: string;
}

export interface SessionState {
  session_id: string;
  transcript_path: string;
  cwd: string;
  profile: string;
  observed_fingerprint: string;
  stable_scans: number;
  last_seen_at: string;
  completed_fingerprint?: string;
  queued_fingerprint?: string;
  attempts: number;
}

export interface CodexState {
  version: 2;
  last_scanned_at?: string;
  sessions: Record<string, SessionState>;
  suppressed_sessions: LegacySessionEntry[];
}

interface ScannerOptions {
  now?: Date;
  homeDir?: string;
  backgroundDir?: string;
  profile?: string;
  scanIntervalMs?: number;
}

interface LoadedState {
  state: CodexState;
  legacyProcessedIds: Set<string>;
}

function log(msg: string) {
  process.stderr.write(`[codex-scanner] ${msg}\n`);
}

function fingerprint(path: string): string {
  const stat = statSync(path);
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

function dateDirForOffset(sessionsDir: string, now: Date, daysBack: number): string {
  const d = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return join(
    sessionsDir,
    String(d.getFullYear()),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
  );
}

async function loadState(statePath: string): Promise<LoadedState> {
  try {
    const parsed = JSON.parse(await Bun.file(statePath).text()) as Partial<CodexState> & {
      processed_sessions?: LegacySessionEntry[];
    };
    return {
      state: {
        version: 2,
        last_scanned_at: parsed.last_scanned_at,
        sessions: parsed.sessions ?? {},
        suppressed_sessions: parsed.suppressed_sessions ?? [],
      },
      legacyProcessedIds: new Set(
        (parsed.processed_sessions ?? []).map(entry => entry.session_id),
      ),
    };
  } catch {
    return {
      state: { version: 2, sessions: {}, suppressed_sessions: [] },
      legacyProcessedIds: new Set(),
    };
  }
}

function saveState(statePath: string, state: CodexState): void {
  mkdirSync(join(statePath, '..'), { recursive: true });
  const tmpPath = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, statePath);
}

function pruneState(state: CodexState, nowMs: number): void {
  for (const [sessionId, session] of Object.entries(state.sessions)) {
    const seenAt = new Date(session.last_seen_at).getTime();
    if (!Number.isFinite(seenAt) || nowMs - seenAt >= EXPIRY_MS) {
      delete state.sessions[sessionId];
    }
  }
  state.suppressed_sessions = state.suppressed_sessions.filter(entry => {
    if (!entry.suppressed_at) return false;
    return nowMs - new Date(entry.suppressed_at).getTime() < EXPIRY_MS;
  });
}

function readAttempt(path: string, fallback: number): number {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { attempt?: number };
    return Math.max(1, parsed.attempt ?? fallback);
  } catch {
    return Math.max(1, fallback);
  }
}

function retryFailedJob(
  failedPath: string,
  pendingPath: string,
  attempt: number,
  nowIso: string,
): boolean {
  try {
    const job = JSON.parse(readFileSync(failedPath, 'utf8')) as Record<string, unknown>;
    job.attempt = attempt + 1;
    job.job_id = crypto.randomUUID();
    job.timestamp = nowIso;
    writeFileSync(pendingPath, JSON.stringify(job, null, 2) + '\n', 'utf8');
    unlinkSync(failedPath);
    return true;
  } catch (err) {
    log(`failed to retry ${failedPath}: ${err}`);
    return false;
  }
}

export async function runCodexScan(options: ScannerOptions = {}): Promise<void> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const home = options.homeDir ?? process.env.HOME ?? '';
  const backgroundDir = options.backgroundDir ?? BACKGROUND_DIR;
  const sessionsDir = join(home, '.codex', 'sessions');
  const statePath = join(backgroundDir, 'state', 'codex.json');
  const pendingDir = join(backgroundDir, 'pending');
  const processingDir = join(backgroundDir, 'processing');
  const failedDir = join(backgroundDir, 'failed');
  const profile = options.profile ?? getActiveProfile();
  const envIntervalMs = Number(process.env.DRAFT_CODEX_SCAN_INTERVAL_MS);
  const scanIntervalMs = options.scanIntervalMs
    ?? (Number.isFinite(envIntervalMs) && envIntervalMs > 0
      ? envIntervalMs
      : 360 * 60_000);

  const { state, legacyProcessedIds } = await loadState(statePath);
  const isFirstScan = !state.last_scanned_at;
  pruneState(state, nowMs);

  mkdirSync(pendingDir, { recursive: true });
  mkdirSync(processingDir, { recursive: true });
  mkdirSync(failedDir, { recursive: true });

  const suppressedIds = new Set(state.suppressed_sessions.map(entry => entry.session_id));
  const daysToScan = isFirstScan ? 1 : EXPIRY_DAYS;
  let observed = 0;
  let queued = 0;
  let retried = 0;
  let skipped = 0;

  for (let daysBack = 0; daysBack < daysToScan; daysBack++) {
    const dir = dateDirForOffset(sessionsDir, now, daysBack);
    if (!existsSync(dir)) continue;

    let files: string[];
    try {
      files = readdirSync(dir).filter(file => file.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const transcriptPath = join(dir, file);
      let sessionId: string | undefined;
      let cwd = '';
      try {
        const firstLine = (await Bun.file(transcriptPath).text()).split('\n')[0];
        const parsed = JSON.parse(firstLine);
        sessionId = parsed?.payload?.session_id as string | undefined;
        cwd = (parsed?.payload?.cwd as string | undefined) ?? '';
      } catch {
        continue;
      }

      if (!sessionId || suppressedIds.has(sessionId)) {
        skipped++;
        continue;
      }

      const currentFingerprint = fingerprint(transcriptPath);
      const pendingPath = join(pendingDir, `codex-${sessionId}.json`);
      const processingPath = join(processingDir, `codex-${sessionId}.json`);
      const failedPath = join(failedDir, `codex-${sessionId}.json`);
      let session = state.sessions[sessionId];

      if (!session) {
        const legacyFailed = existsSync(failedPath);
        session = {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd,
          profile,
          observed_fingerprint: currentFingerprint,
          stable_scans: 1,
          last_seen_at: nowIso,
          completed_fingerprint:
            legacyProcessedIds.has(sessionId) && !legacyFailed
              ? currentFingerprint
              : undefined,
          queued_fingerprint: legacyFailed ? currentFingerprint : undefined,
          attempts: legacyFailed ? readAttempt(failedPath, 1) : 0,
        };
        state.sessions[sessionId] = session;
        observed++;
        continue;
      }

      session.last_seen_at = nowIso;
      session.transcript_path = transcriptPath;
      session.cwd = cwd;

      if (session.observed_fingerprint !== currentFingerprint) {
        session.observed_fingerprint = currentFingerprint;
        session.stable_scans = 1;
        session.queued_fingerprint = undefined;
        session.attempts = 0;
        observed++;
        continue;
      }

      session.stable_scans++;

      if (session.queued_fingerprint === currentFingerprint) {
        if (existsSync(pendingPath) || existsSync(processingPath)) {
          skipped++;
          continue;
        }

        if (existsSync(failedPath)) {
          const attempt = readAttempt(failedPath, session.attempts || 1);
          session.attempts = attempt;
          if (attempt >= MAX_ATTEMPTS) {
            skipped++;
            continue;
          }
          const failedAgeMs = nowMs - statSync(failedPath).mtimeMs;
          const retryDelayMs = scanIntervalMs * 2 ** (attempt - 1);
          if (failedAgeMs < retryDelayMs) {
            skipped++;
            continue;
          }
          if (retryFailedJob(failedPath, pendingPath, attempt, nowIso)) {
            session.attempts = attempt + 1;
            retried++;
          }
          continue;
        }

        session.completed_fingerprint = currentFingerprint;
        session.queued_fingerprint = undefined;
        session.attempts = 0;
      }

      if (
        session.stable_scans < 2
        || session.completed_fingerprint === currentFingerprint
        || session.queued_fingerprint === currentFingerprint
      ) {
        skipped++;
        continue;
      }

      const job = {
        job_id: crypto.randomUUID(),
        session_id: sessionId,
        transcript_path: transcriptPath,
        transcript_fingerprint: currentFingerprint,
        source: 'codex-session',
        profile: session.profile,
        cwd,
        reason: 'periodic_scan',
        timestamp: nowIso,
        attempt: 1,
      };
      try {
        writeFileSync(pendingPath, JSON.stringify(job, null, 2) + '\n', 'utf8');
        session.queued_fingerprint = currentFingerprint;
        session.attempts = 1;
        queued++;
      } catch (err) {
        log(`failed to write pending job for ${sessionId}: ${err}`);
      }
    }
  }

  state.last_scanned_at = nowIso;
  saveState(statePath, state);
  log(
    `scan complete — observed=${observed} queued=${queued} retried=${retried} skipped=${skipped}`,
  );
}

if (import.meta.main) {
  await runCodexScan();
}
