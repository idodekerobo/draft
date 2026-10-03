// background/draft-background.ts — Draft background daemon (Bun)
//
// Replaces draft-daemon.sh. Runs as a LaunchAgent (always-on, auto-restart via KeepAlive).
// Event loop: polls pending/ for Codex scanner jobs and processes them.
//
// Logs: structured JSON to ~/.draft/background/logs/daemon.log
// stdout/stderr are captured by LaunchAgent to logs/daemon.log / logs/daemon-error.log

import { PostHog } from 'posthog-node';
import { getActiveProfile, getWorkspacePath, BACKGROUND_DIR, readDraftConfig, readLocalConfig, ensureAnalyticsConfig } from 'draft-core/config';
import { runMigrations } from 'draft-core/migrations/runner';
import { isToday } from 'draft-core/time';
import { resolveRuntimeEntrypoint, runtimeCommand } from 'draft-core/runtime';
import { mkdirSync, existsSync, appendFileSync, openSync, readdirSync, readFileSync, unlinkSync, renameSync, writeFileSync } from 'fs';
import { synthesize } from './synthesize';

const DRAFT_BACKGROUND = BACKGROUND_DIR;

// Paths — mirrors config.sh exports
const ACTIVE_PROFILE  = getActiveProfile();
const DRAFT_WORKSPACE = getWorkspacePath(ACTIVE_PROFILE);
const DRAFT_PENDING    = `${DRAFT_BACKGROUND}/pending`;
const DRAFT_PROCESSING = `${DRAFT_BACKGROUND}/processing`;
const DRAFT_FAILED     = `${DRAFT_BACKGROUND}/failed`;
const DRAFT_DEFERRED   = `${DRAFT_BACKGROUND}/deferred`;
const DRAFT_LOGS       = `${DRAFT_BACKGROUND}/logs`;
const STATE_DIR        = `${DRAFT_BACKGROUND}/state`;

// Codex session synthesis jobs are expensive. If the daemon was off for a few days, don't drain the
// whole backlog on restart: only synthesize sessions from today, and move
// older ones to deferred/ instead of processing or deleting them.
const SESSION_JOB_SOURCES = new Set(['codex-session']);

// Per-profile local config — read once at startup
const _localCfgResult = readLocalConfig(DRAFT_WORKSPACE);
const _localCfg       = _localCfgResult.ok ? _localCfgResult.config : {};
const CODEX_SCAN_ENABLED       = _localCfg.codexScanIntervalMinutes !== null;
const CODEX_SCAN_INTERVAL_MS   = (_localCfg.codexScanIntervalMinutes ?? 360) * 60_000;

// Polling intervals — env var overrides with same defaults as config.sh
const PENDING_POLL_MS   = parseInt(process.env.DRAFT_PENDING_POLL   ?? '5')     * 1000;

// Ensure runtime directories exist (mkdirSync before openSync below)
mkdirSync(DRAFT_PENDING,    { recursive: true });
mkdirSync(DRAFT_PROCESSING, { recursive: true });
mkdirSync(DRAFT_FAILED,     { recursive: true });
mkdirSync(DRAFT_DEFERRED,   { recursive: true });
mkdirSync(DRAFT_LOGS,       { recursive: true });
mkdirSync(STATE_DIR,        { recursive: true });

// ── Analytics ────────────────────────────────────────────────────────────────
// Key baked in at compile time via prebuild.sh --define; falls back to env in dev mode.

const _phKey  = process.env.DRAFT_PH_KEY  ?? '';
const _phHost = process.env.DRAFT_PH_HOST ?? 'https://us.i.posthog.com';

const _draftCfg  = readDraftConfig();
const _analytics = ensureAnalyticsConfig(_draftCfg.ok ? _draftCfg.config : { version: '1', tools: {} });

const phClient = _phKey
  ? new PostHog(_phKey, { host: _phHost })
  : null;

function phTrack(event: string, properties: Record<string, unknown> = {}) {
  if (!phClient)                           return;
  if (_analytics.consent !== 'opted_in')   return;
  if (!_analytics.anonymous_id)            return;
  phClient.capture({ distinctId: _analytics.anonymous_id, event, properties });
}

// ── Logging ──────────────────────────────────────────────────────────────────

const LOG_PATH      = `${DRAFT_LOGS}/daemon.log`;
const MAX_LOG_LINES = 10_000;
const KEEP_LINES    = 5_000;

// Append-mode fd — routes Codex scanner output into daemon.log.
// Must be opened after mkdirSync(DRAFT_LOGS) above.
const logFd = openSync(LOG_PATH, 'a');

function log(level: 'info' | 'warn' | 'error', msg: string) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n';
  appendFileSync(LOG_PATH, line);
}

async function trimLog() {
  if (!existsSync(LOG_PATH)) return;
  const content = await Bun.file(LOG_PATH).text();
  const lines = content.split('\n').filter(Boolean);
  if (lines.length > MAX_LOG_LINES) {
    const trimmed = lines.slice(-KEEP_LINES).join('\n') + '\n';
    await Bun.write(LOG_PATH, trimmed); // overwrite intentionally — this IS the trim
    log('info', `log trimmed (${lines.length} → ${KEEP_LINES} lines)`);
  }
}

// ── Heartbeat ────────────────────────────────────────────────────────────────
// Desktop reads mtime for alive/dead detection (stale >2min = stopped).
// Parses JSON for status header: "● running · profile: acme · synced 4m ago"

async function readLastSynthesis(): Promise<string> {
  const path = `${STATE_DIR}/last-synthesis`;
  if (!existsSync(path)) return '';
  return (await Bun.file(path).text()).trim();
}

async function writeHeartbeat() {
  const lastSync = await readLastSynthesis();
  const payload = JSON.stringify({
    pid:       process.pid,
    profile:   ACTIVE_PROFILE,
    ts:        new Date().toISOString(),
    last_sync: lastSync,
  });
  await Bun.write(`${STATE_DIR}/last-heartbeat`, payload + '\n');
}

// ── Job processing ────────────────────────────────────────────────────────────

async function processJob(jobPath: string) {
  const jobName = jobPath.split('/').pop()!;
  log('info', `processing job: ${jobName}`);

  // Move to processing/ immediately so the next poll tick doesn't re-pick it
  const processingPath = `${DRAFT_PROCESSING}/${jobName}`;
  try {
    renameSync(jobPath, processingPath);
  } catch {
    // Another tick already moved it — skip
    return;
  }

  // Validate JSON — malformed files go to failed/
  let job: Record<string, unknown>;
  try {
    job = JSON.parse(await Bun.file(processingPath).text());
  } catch {
    log('error', `invalid JSON in ${jobName} — quarantining to failed/`);
    renameSync(processingPath, `${DRAFT_FAILED}/${jobName}`);
    return;
  }

  const profile   = String(job.profile    ?? 'default');
  const sessionId = String(job.session_id ?? 'unknown');
  log('info', `job ${jobName}: profile=${profile} session_id=${sessionId}`);

  // Route to the TypeScript synthesis module.
  const jobSource = String(job.source ?? 'codex-session');

  // Session-synthesis jobs are expensive (real LLM calls). If this job is from
  // a prior day — e.g. the daemon was off and the backlog piled up — defer it
  // instead of burning tokens processing the whole backlog on restart.
  if (SESSION_JOB_SOURCES.has(jobSource) && !isToday(job.timestamp as string | undefined)) {
    log('info', `job ${jobName}: not from today — deferring (source=${jobSource})`);
    try { renameSync(processingPath, `${DRAFT_DEFERRED}/${jobName}`); } catch {}
    return;
  }

  const result = await synthesize(processingPath);
  if (result.status === 'deferred') {
    log('info', `job ${jobName}: deferred (workspace busy) — returning to pending/`);
    try { renameSync(processingPath, `${DRAFT_PENDING}/${jobName}`); } catch {}
    return;
  }
  if (result.status === 'success' || result.status === 'skipped') {
    try { unlinkSync(processingPath); } catch {}
    log('info', `job ${jobName} complete (${result.status})`);
    phTrack('daemon_synthesis_completed', { source: jobSource, status: result.status });
  } else {
    log('error', `synthesize ${result.status} for ${jobName} — quarantining to failed/`);
    try { renameSync(processingPath, `${DRAFT_FAILED}/${jobName}`); } catch {}
    phTrack('daemon_synthesis_failed', { source: jobSource, status: result.status });
  }
}

async function processPendingJobs() {
  let files: string[];
  try { files = readdirSync(DRAFT_PENDING).filter(f => f.startsWith('codex-') && f.endsWith('.json')); }
  catch { return; }
  for (const f of files) await processJob(`${DRAFT_PENDING}/${f}`);
}

// ── Singleton guard ──────────────────────────────────────────────────────────
// Prevents multiple daemon processes from running simultaneously (e.g. launchd
// restarts, desktop app relaunches, manual starts).

const PID_FILE = `${DRAFT_BACKGROUND}/draft-background.pid`;

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

if (existsSync(PID_FILE)) {
  try {
    const existingPid = parseInt(readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
      log('info', `daemon already running (pid=${existingPid}) — exiting`);
      process.exit(0);
    }
  } catch { /* stale or unreadable — proceed to replace */ }
}

writeFileSync(PID_FILE, String(process.pid));

// ── Recover stale processing jobs ────────────────────────────────────────────
// On startup, any files in processing/ are from a previous daemon that died
// mid-synthesis. Move them to failed/ so they don't get stuck forever.

try {
  const staleFiles = readdirSync(DRAFT_PROCESSING).filter(f => f.startsWith('codex-') && f.endsWith('.json'));
  for (const f of staleFiles) {
    const src = `${DRAFT_PROCESSING}/${f}`;
    let dst = `${DRAFT_FAILED}/${f}`;
    if (existsSync(dst)) {
      dst = `${DRAFT_FAILED}/${f.replace('.json', '')}-stale-${Date.now()}.json`;
    }
    try {
      renameSync(src, dst);
      log('warn', `stale processing job found on startup — quarantined: ${f}`);
    } catch { /* race with another process — ignore */ }
  }
} catch { /* ENOENT or unreadable — fine */ }

// ── Startup log (before arming timers — matches bash daemon ordering) ─────────

async function main(): Promise<void> {
  await runMigrations();

  log('info', `draft daemon starting (pid=${process.pid}, profile=${ACTIVE_PROFILE})`);
  phTrack('daemon_started');
  // ── Codex session scanner ────────────────────────────────────────────────────

  function spawnRuntime(pathWithoutExtension: string, env?: Record<string, string>): boolean {
    const entrypoint = resolveRuntimeEntrypoint(pathWithoutExtension);
    if (!entrypoint) return false;
    const command = runtimeCommand(entrypoint);
    if (!command) {
      log('warn', `runtime: bun not found for ${entrypoint.path}`);
      return false;
    }
    Bun.spawn(command, {
      stdin: 'ignore', stdout: logFd, stderr: logFd,
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    return true;
  }

  function runCodexScan() {
    log('info', `codex: starting scan (interval=${CODEX_SCAN_INTERVAL_MS / 60_000}m)`);
    spawnRuntime(`${DRAFT_BACKGROUND}/integrations/codex/codex-scanner`, {
      DRAFT_CODEX_SCAN_INTERVAL_MS: String(CODEX_SCAN_INTERVAL_MS),
    });
  }

  if (CODEX_SCAN_ENABLED) {
    setInterval(runCodexScan, CODEX_SCAN_INTERVAL_MS);
    runCodexScan(); // immediate first scan on startup
  }

  // ── Main poll loop ────────────────────────────────────────────────────────────

  let loopCount = 0;
  let tickInProgress = false;

  async function tick() {
    await writeHeartbeat();
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      await processPendingJobs();
      loopCount++;
      if (loopCount % 1000 === 0) await trimLog();
    } finally {
      tickInProgress = false;
    }
  }

  setInterval(tick, PENDING_POLL_MS);
  void tick(); // immediate first tick

  // Daily alive ping — independent of poll loop cadence
  setInterval(() => phTrack('daemon_daily_alive'), 24 * 60 * 60 * 1000);

  // ── Signal handling ───────────────────────────────────────────────────────────

  process.on('SIGTERM', async () => {
    log('info', 'daemon stopping (SIGTERM)');
    try { unlinkSync(PID_FILE); } catch { /* already gone */ }
    await phClient?.shutdown();
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    log('info', 'daemon stopping (SIGINT)');
    try { unlinkSync(PID_FILE); } catch { /* already gone */ }
    await phClient?.shutdown();
    process.exit(0);
  });
}

void main().catch((error: unknown) => {
  log('error', `daemon startup failed: ${error instanceof Error ? error.message : String(error)}`);
  try { unlinkSync(PID_FILE); } catch { /* already gone */ }
  process.exit(1);
});
