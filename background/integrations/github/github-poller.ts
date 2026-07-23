// Poll GitHub for repository activity and enqueue synthesis work.
//
// This process deliberately does not synthesize directly. The daemon consumes
// the durable queue job and routes it through the common synthesis pipeline.

import {
  closeSync,
  constants,
  fdatasyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { dirname, join } from 'path';
import { BACKGROUND_DIR, getActiveProfile, getWorkspacePath } from 'draft-core/config';
import { resolveRunnerBin } from 'draft-core/agents/headless';
import { atomicPatch } from 'draft-core/sync/atomic-write';

export interface GitHubState {
  last_polled_at: string | null;
  processed_pr_ids: string[];
  processed_release_tags: string[];
}

interface GitHubConfig {
  repos?: unknown;
}

export interface GitHubItem {
  [key: string]: unknown;
  repo: string;
}

export interface GitHubContext {
  type: 'github';
  profile: string;
  timestamp: string;
  last_polled_at: string | null;
  repos: string[];
  merged_prs: GitHubItem[];
  releases: GitHubItem[];
  open_prs: GitHubItem[];
  new_pr_ids: string[];
  new_release_tags: string[];
  /** Only a fully successful set of merged-PR/release queries may advance this poll's watermark. */
  advance_watermark: boolean;
}

const STATE_PATH = join(BACKGROUND_DIR, 'state', 'github.json');
const PENDING_DIR = join(BACKGROUND_DIR, 'pending');

function log(level: 'info' | 'warn' | 'error', msg: string): void {
  process.stderr.write(`${JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component: 'github-poller',
    msg,
  })}\n`);
}

export function defaultState(): GitHubState {
  return {
    last_polled_at: null,
    processed_pr_ids: [],
    processed_release_tags: [],
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export async function readGitHubState(statePath = STATE_PATH): Promise<GitHubState> {
  try {
    const parsed = JSON.parse(await Bun.file(statePath).text()) as Partial<GitHubState>;
    return {
      last_polled_at: typeof parsed.last_polled_at === 'string' ? parsed.last_polled_at : null,
      processed_pr_ids: stringArray(parsed.processed_pr_ids),
      processed_release_tags: stringArray(parsed.processed_release_tags),
    };
  } catch {
    return defaultState();
  }
}

async function advancePollWatermark(timestamp: string): Promise<void> {
  await atomicPatch(STATE_PATH, (raw) => {
    let state = defaultState();
    try {
      const parsed = JSON.parse(raw) as Partial<GitHubState>;
      state = {
        last_polled_at: typeof parsed.last_polled_at === 'string' ? parsed.last_polled_at : null,
        processed_pr_ids: stringArray(parsed.processed_pr_ids),
        processed_release_tags: stringArray(parsed.processed_release_tags),
      };
    } catch {}
    if (state.last_polled_at && state.last_polled_at >= timestamp) return raw;
    return `${JSON.stringify({ ...state, last_polled_at: timestamp }, null, 2)}\n`;
  });
}

const MAX_PROCESSED_ITEMS = 1_000;

/**
 * Blank release-only polls never enter the synthesis queue, so they must be
 * acknowledged here. Successfully inspected tags are safe to acknowledge even
 * when another query failed; the watermark only advances after a fully
 * successful poll so failed/unknown activity remains discoverable on retry.
 */
export async function acknowledgeSuppressedReleases(
  statePath: string,
  tags: string[],
  timestamp: string,
  advanceWatermark: boolean,
): Promise<void> {
  await atomicPatch(statePath, (raw) => {
    let state = defaultState();
    try {
      const parsed = JSON.parse(raw) as Partial<GitHubState>;
      state = {
        last_polled_at: typeof parsed.last_polled_at === 'string' ? parsed.last_polled_at : null,
        processed_pr_ids: stringArray(parsed.processed_pr_ids),
        processed_release_tags: stringArray(parsed.processed_release_tags),
      };
    } catch {}

    const processedReleaseTags = [...new Set([
      ...state.processed_release_tags,
      ...tags,
    ])].slice(-MAX_PROCESSED_ITEMS);
    const lastPolledAt = advanceWatermark
      && (!state.last_polled_at || timestamp > state.last_polled_at)
      ? timestamp
      : state.last_polled_at;
    return `${JSON.stringify({
      ...state,
      last_polled_at: lastPolledAt,
      processed_release_tags: processedReleaseTags,
    }, null, 2)}\n`;
  });
}

/**
 * Write a JSON file with data and rename durability. The temporary file lives
 * beside the destination, so rename is atomic on the target filesystem.
 */
function writeJsonDurable(filePath: string, value: unknown): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const tmpPath = join(parent, `.${filePath.split('/').pop()}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;

  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeSync(fd, contents, 0, 'utf8');
    fdatasyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, filePath);

    // Best effort: persist the directory entry created by rename.
    const dirFd = openSync(parent, constants.O_RDONLY);
    try { fdatasyncSync(dirFd); } catch {} finally { closeSync(dirFd); }
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch {}
    }
    try { unlinkSync(tmpPath); } catch {}
    throw error;
  }
}

export interface GhQueryResult {
  ok: boolean;
  value?: unknown;
}

async function runGhJson(ghBin: string, args: string[], description: string): Promise<GhQueryResult> {
  try {
    const proc = Bun.spawn([ghBin, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    ]);
    if (exitCode !== 0) {
      log('warn', `${description} failed (exit=${exitCode}): ${stderr.trim().slice(0, 500)}`);
      return { ok: false };
    }
    return { ok: true, value: JSON.parse(stdout || 'null') };
  } catch (error) {
    log('warn', `${description} failed: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false };
  }
}

export interface GitHubPollDependencies {
  query(args: string[], description: string): Promise<GhQueryResult>;
  enqueue(job: Record<string, unknown>): Promise<void> | void;
  acknowledgeSuppressed(tags: string[], timestamp: string, advanceWatermark: boolean): Promise<void>;
  advanceWatermark(timestamp: string): Promise<void>;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface GitHubPollInput {
  profile: string;
  repos: string[];
  state: GitHubState;
  polledAt: string;
}

export type GitHubPollOutcome = 'queued' | 'suppressed' | 'no-activity' | 'partial-failure';

function arrayResult(result: GhQueryResult): { ok: boolean; items: unknown[] } {
  return result.ok && Array.isArray(result.value)
    ? { ok: true, items: result.value }
    : { ok: false, items: [] };
}

function objectResult(result: GhQueryResult): { ok: boolean; item?: Record<string, unknown> } {
  return result.ok && result.value !== null && typeof result.value === 'object' && !Array.isArray(result.value)
    ? { ok: true, item: result.value as Record<string, unknown> }
    : { ok: false };
}

export function hasMeaningfulReleaseNotes(body: unknown): boolean {
  return typeof body === 'string' && body.trim().length > 0;
}

/** Fetch GitHub activity and either enqueue it or deterministically acknowledge noise. */
export async function runGitHubPoll(
  input: GitHubPollInput,
  dependencies: GitHubPollDependencies,
): Promise<GitHubPollOutcome> {
  const { profile, repos, state, polledAt } = input;
  const writeLog = dependencies.log ?? (() => {});
  const processedPrIds = new Set(state.processed_pr_ids);
  const processedReleaseTags = new Set(state.processed_release_tags);
  const context: GitHubContext = {
    type: 'github',
    profile,
    timestamp: polledAt,
    last_polled_at: state.last_polled_at,
    repos,
    merged_prs: [],
    releases: [],
    open_prs: [],
    new_pr_ids: [],
    new_release_tags: [],
    advance_watermark: true,
  };

  for (const repo of repos) {
    const mergedResult = arrayResult(await dependencies.query([
      'pr', 'list', '--repo', repo, '--state', 'merged',
      '--json', 'number,title,body,author,mergedAt', '--limit', '20',
    ], `fetch merged PRs for ${repo}`));
    if (!mergedResult.ok) context.advance_watermark = false;
    for (const raw of mergedResult.items) {
      if (!raw || typeof raw !== 'object') continue;
      const pr = raw as Record<string, unknown>;
      if (typeof pr.number !== 'number' && typeof pr.number !== 'string') continue;
      const id = `${repo}:${String(pr.number)}`;
      const mergedAt = typeof pr.mergedAt === 'string' ? pr.mergedAt : '';
      if (processedPrIds.has(id)) continue;
      if (state.last_polled_at && mergedAt && mergedAt < state.last_polled_at) continue;
      context.merged_prs.push({ ...pr, repo });
      context.new_pr_ids.push(id);
    }

    // `gh release list` does not support the release body field. Fetch only
    // cheap metadata here, then inspect notes for each newly discovered tag.
    const releaseResult = arrayResult(await dependencies.query([
      'release', 'list', '--repo', repo,
      '--json', 'tagName,name,publishedAt', '--limit', '5',
    ], `fetch releases for ${repo}`));
    if (!releaseResult.ok) context.advance_watermark = false;
    for (const raw of releaseResult.items) {
      if (!raw || typeof raw !== 'object') continue;
      const release = raw as Record<string, unknown>;
      const tag = typeof release.tagName === 'string' ? release.tagName : '';
      if (!tag) continue;
      const id = `${repo}:${tag}`;
      const publishedAt = typeof release.publishedAt === 'string' ? release.publishedAt : '';
      if (processedReleaseTags.has(id)) continue;
      if (state.last_polled_at && publishedAt && publishedAt < state.last_polled_at) continue;

      const bodyResult = objectResult(await dependencies.query([
        'release', 'view', tag, '--repo', repo, '--json', 'body',
      ], `fetch release notes for ${repo}@${tag}`));
      if (!bodyResult.ok) {
        // Do not queue or acknowledge this tag. Keeping the watermark fixed
        // guarantees the release body is retried on the next poll.
        context.advance_watermark = false;
        continue;
      }
      const body = typeof bodyResult.item?.body === 'string' ? bodyResult.item.body : '';
      context.releases.push({ ...release, body, repo });
      context.new_release_tags.push(id);
    }

    // Open PRs are supplemental context, not a trigger or watermark input.
    const openPrResult = arrayResult(await dependencies.query([
      'pr', 'list', '--repo', repo, '--state', 'open',
      '--json', 'number,title,author,createdAt,reviewDecision', '--limit', '10',
    ], `fetch open PRs for ${repo}`));
    for (const raw of openPrResult.items) {
      if (raw && typeof raw === 'object') context.open_prs.push({ ...(raw as Record<string, unknown>), repo });
    }
  }

  writeLog('info', `fetched: ${context.merged_prs.length} merged PRs, ${context.releases.length} releases, ${context.open_prs.length} open PRs`);

  if (context.new_pr_ids.length === 0 && context.new_release_tags.length === 0) {
    if (!context.advance_watermark) {
      writeLog('warn', 'critical GitHub query failed — preserving previous poll watermark');
      return 'partial-failure';
    }
    await dependencies.advanceWatermark(polledAt);
    writeLog('info', 'no new GitHub activity since last poll');
    return 'no-activity';
  }

  const releaseOnlyNoise = context.new_pr_ids.length === 0
    && context.releases.length > 0
    && context.releases.every(release => !hasMeaningfulReleaseNotes(release.body));
  if (releaseOnlyNoise) {
    await dependencies.acknowledgeSuppressed(
      context.new_release_tags,
      polledAt,
      context.advance_watermark,
    );
    writeLog('info', `suppressed ${context.new_release_tags.length} release(s) with blank notes`);
    return 'suppressed';
  }

  await dependencies.enqueue({
    source: 'github',
    profile,
    timestamp: polledAt,
    reason: 'scheduled_poll',
    github_context: context,
  });
  return 'queued';
}

async function main(): Promise<void> {
  const ghBin = await resolveRunnerBin('gh');
  if (!ghBin) {
    log('warn', 'gh CLI not installed — skipping (install from https://cli.github.com/)');
    return;
  }

  let authExit: number;
  try {
    const auth = Bun.spawn([ghBin, 'auth', 'status'], {
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    });
    authExit = await auth.exited;
  } catch (error) {
    log('error', `failed to run gh CLI at ${ghBin}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (authExit !== 0) {
    log('warn', 'gh CLI not authenticated — skipping (run: gh auth login)');
    return;
  }

  const profile = getActiveProfile();
  const workspace = getWorkspacePath(profile);
  const configPath = join(workspace, 'config', 'github.json');

  let repos: string[];
  try {
    const config = JSON.parse(await Bun.file(configPath).text()) as GitHubConfig;
    repos = stringArray(config.repos).map(repo => repo.trim()).filter(Boolean);
  } catch {
    log('info', `no readable github config found for profile '${profile}' — skipping (run /draft:connect github to configure)`);
    return;
  }
  if (repos.length === 0) {
    log('info', 'repos list is empty in github config — skipping');
    return;
  }

  const state = await readGitHubState();
  const polledAt = new Date().toISOString();

  log('info', `starting poll (last_polled=${state.last_polled_at ?? 'never'}, repos=${repos.join(' ')})`);
  const outcome = await runGitHubPoll({ profile, repos, state, polledAt }, {
    query: (args, description) => runGhJson(ghBin, args, description),
    enqueue: (job) => {
      const jobPath = join(PENDING_DIR, `job-github-${crypto.randomUUID()}.json`);
      writeJsonDurable(jobPath, job);
      log('info', `queued synthesis job: ${jobPath}`);
    },
    acknowledgeSuppressed: (tags, timestamp, shouldAdvance) =>
      acknowledgeSuppressedReleases(STATE_PATH, tags, timestamp, shouldAdvance),
    advanceWatermark: advancePollWatermark,
    log,
  });
  if (outcome === 'queued') {
    log('info', 'poll complete (state acknowledgment deferred until synthesis succeeds)');
  }
}

if (import.meta.main) {
  await main().catch((error) => {
    log('error', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
