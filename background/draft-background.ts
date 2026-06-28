// background/draft-background.ts — Draft background daemon (Bun)
//
// Replaces draft-daemon.sh. Runs as a LaunchAgent (always-on, auto-restart via KeepAlive).
// Event loop: polls pending/ for session-end job files, processes them.
//
// Logs: structured JSON to ~/.draft/background/logs/daemon.log
// stdout/stderr are captured by LaunchAgent to logs/daemon.log / logs/daemon-error.log

import { PostHog } from 'posthog-node';
import { getActiveProfile, getWorkspacePath, BACKGROUND_DIR, readDraftConfig, ensureAnalyticsConfig } from 'draft-core/config';
import { runMigrations } from 'draft-core/migrations/runner';
import { reconcileSkillManifest, detectPending } from 'draft-core/scanner';
import { mkdirSync, existsSync, appendFileSync, openSync, readdirSync, readFileSync, unlinkSync, renameSync, writeFileSync } from 'fs';
import { synthesize } from './synthesize';

const DRAFT_BACKGROUND = BACKGROUND_DIR;

// Paths — mirrors config.sh exports
const ACTIVE_PROFILE  = getActiveProfile();
const DRAFT_WORKSPACE = getWorkspacePath(ACTIVE_PROFILE);
const DRAFT_PENDING    = `${DRAFT_BACKGROUND}/pending`;
const DRAFT_PROCESSING = `${DRAFT_BACKGROUND}/processing`;
const DRAFT_FAILED     = `${DRAFT_BACKGROUND}/failed`;
const DRAFT_LOGS       = `${DRAFT_BACKGROUND}/logs`;
const STATE_DIR        = `${DRAFT_BACKGROUND}/state`;

// Polling intervals — env var overrides with same defaults as config.sh
const PENDING_POLL_MS   = parseInt(process.env.DRAFT_PENDING_POLL   ?? '5')     * 1000;
const GRANOLA_POLL_MS   = parseInt(process.env.DRAFT_GRANOLA_POLL   ?? '900')   * 1000;
const SLACK_MANAGER_MS  = 60_000;
const SLACK_ANALYSIS_MS = parseInt(process.env.DRAFT_SLACK_ANALYSIS ?? '14400') * 1000;
const GITHUB_POLL_MS    = parseInt(process.env.DRAFT_GITHUB_POLL    ?? '3600')  * 1000;
const SKILL_SYNC_MS      = 5 * 60 * 1000;

// Ensure runtime directories exist (mkdirSync before openSync below)
mkdirSync(DRAFT_PENDING,    { recursive: true });
mkdirSync(DRAFT_PROCESSING, { recursive: true });
mkdirSync(DRAFT_FAILED,     { recursive: true });
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

// Append-mode fd — reused by all Bun.spawn poller calls to route stdout/stderr
// into daemon.log (mirrors bash daemon's `>> "$DRAFT_LOGS/daemon.log" 2>&1 &` pattern).
// Must be opened after mkdirSync(DRAFT_LOGS) above.
const logFd = openSync(LOG_PATH, 'a');

function log(level: 'info' | 'warn' | 'error', msg: string) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n';
  appendFileSync(LOG_PATH, line);
}

function reconcileSkills() {
  try {
    const reconciled = reconcileSkillManifest();
    if (reconciled.repaired.length > 0) log('info', `skills: repaired ${reconciled.repaired.length} symlink(s)`);
    if (reconciled.tombstoned.length > 0) log('info', `skills: tombstoned ${reconciled.tombstoned.length} removed skill(s)`);
    if (reconciled.orphaned.length > 0) log('warn', `skills: ${reconciled.orphaned.length} symlink(s) with missing source — open Draft to review`);
    if (reconciled.conflicts.length > 0) log('warn', `skills: ${reconciled.conflicts.length} symlink conflict(s) — open Draft to resolve`);

    const { pending, conflicts } = detectPending();
    if (pending.length > 0) log('info', `skills: ${pending.length} new skill(s) pending approval — open Draft to sync`);
    if (conflicts.length > 0) log('warn', `skills: ${conflicts.length} same-name conflict(s) — open Draft to resolve`);
  } catch {
    log('warn', 'skills: reconciliation failed');
  }
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

  // Route to synthesize.ts module (replaced synthesize.sh)
  const jobSource = String(job.source ?? 'claude-code-session');
  const result = await synthesize(processingPath);
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
  try { files = readdirSync(DRAFT_PENDING).filter(f => f.endsWith('.json')); }
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
  const staleFiles = readdirSync(DRAFT_PROCESSING).filter(f => f.endsWith('.json'));
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

log('info', `draft daemon starting (pid=${process.pid}, profile=${ACTIVE_PROFILE})`);
phTrack('daemon_started');
await runMigrations();
reconcileSkills();

// ── Integration pollers (interval-based) ─────────────────────────────────────
// All pollers fire-and-forget via Bun.spawn, matching bash &-backgrounded pattern.
// stdout/stderr routed to logFd so poller log output lands in daemon.log.

// Granola poller
setInterval(() => {
  const script = `${DRAFT_BACKGROUND}/integrations/granola/granola-poller.sh`;
  if (!existsSync(script)) return;
  const mode = process.env.DRAFT_GRANOLA_MODE ?? 'mcp';
  log('info', `granola: starting poll (interval=${GRANOLA_POLL_MS / 1000}s mode=${mode})`);
  Bun.spawn(['bash', script], { stdin: 'ignore', stdout: logFd, stderr: logFd });
}, GRANOLA_POLL_MS);

// Slack manager (process health check — ensures slack-capture.ts is running if Slack is configured)
setInterval(() => {
  const script = `${DRAFT_BACKGROUND}/integrations/slack/slack-manager.sh`;
  if (!existsSync(script)) return;
  Bun.spawn(['bash', script], { stdin: 'ignore', stdout: logFd, stderr: logFd });
}, SLACK_MANAGER_MS);

// Slack analyzer (synthesis batch)
setInterval(() => {
  const script = `${DRAFT_BACKGROUND}/integrations/slack/slack-analyzer.sh`;
  if (!existsSync(script)) return;
  log('info', `slack: starting analysis (interval=${SLACK_ANALYSIS_MS / 1000}s)`);
  Bun.spawn(['bash', script], { stdin: 'ignore', stdout: logFd, stderr: logFd });
}, SLACK_ANALYSIS_MS);

// GitHub poller
setInterval(() => {
  const ghConfig = `${DRAFT_WORKSPACE}/config/github.json`;
  const script   = `${DRAFT_BACKGROUND}/integrations/github/github-poller.sh`;
  if (!existsSync(ghConfig) || !existsSync(script)) return;
  log('info', `github: starting poll (interval=${GITHUB_POLL_MS / 1000}s)`);
  Bun.spawn(['bash', script], { stdin: 'ignore', stdout: logFd, stderr: logFd });
}, GITHUB_POLL_MS);

// Skills are user-owned files; reconcile separately from synthesis so they keep
// syncing while the desktop app is closed.
setInterval(reconcileSkills, SKILL_SYNC_MS);

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
