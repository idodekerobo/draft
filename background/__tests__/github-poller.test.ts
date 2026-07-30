import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  acknowledgeSuppressedReleases,
  defaultState,
  readGitHubState,
  runGitHubPoll,
  type GhQueryResult,
  type GitHubState,
} from '../integrations/github/github-poller';

const ROOT = `/tmp/draft-github-poller-test-${process.pid}`;
const NOW = '2026-07-22T12:00:00.000Z';
const REPO = 'draft/example';

type Query = { args: string[]; description: string };

function successfulDefaults(args: string[]): GhQueryResult {
  if (args[0] === 'release' && args[1] === 'view') return { ok: true, value: { body: '' } };
  if (args[0] === 'pr' && args[1] === 'view') {
    return { ok: true, value: { body: '', commits: [], files: [{ path: 'README.md' }] } };
  }
  return { ok: true, value: [] };
}

async function poll(options: {
  state?: GitHubState;
  repos?: string[];
  respond?: (args: string[]) => GhQueryResult;
} = {}) {
  const queries: Query[] = [];
  const jobs: Record<string, unknown>[] = [];
  const suppressed: Array<{ tags: string[]; timestamp: string; advance: boolean }> = [];
  const watermarks: string[] = [];
  const outcome = await runGitHubPoll({
    profile: 'test',
    repos: options.repos ?? [REPO],
    state: options.state ?? defaultState(),
    polledAt: NOW,
  }, {
    query: async (args, description) => {
      queries.push({ args, description });
      return options.respond?.(args) ?? successfulDefaults(args);
    },
    enqueue: (job) => { jobs.push(job); },
    acknowledgeSuppressed: async (tags, timestamp, advance) => {
      suppressed.push({ tags, timestamp, advance });
    },
    advanceWatermark: async (timestamp) => { watermarks.push(timestamp); },
  });
  return { outcome, queries, jobs, suppressed, watermarks };
}

function releases(...items: Array<Record<string, unknown>>): GhQueryResult {
  return { ok: true, value: items };
}

function githubContext(job: Record<string, unknown>): Record<string, unknown> {
  return job.github_context as Record<string, unknown>;
}

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('GitHub merged PR evidence retrieval', () => {
  it('uses the merged list only for discovery and fetches full normalized PR evidence', async () => {
    const body = `Why this matters\r\n\r\n${'customer evidence '.repeat(20)}  `;
    const result = await poll({ respond: (args) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return {
          ok: true,
          value: [{ number: 42, title: 'Ship evidence', author: { login: 'octo' }, mergedAt: NOW }],
        };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          ok: true,
          value: {
            body,
            commits: [{
              messageHeadline: 'Add customer workflow',
              messageBody: 'Preserve the complete rationale.\r\nSecond line.  ',
            }],
            files: [
              { path: 'src/workflow.ts', additions: 31, deletions: 4, patch: 'SECRET DIFF CONTENT' },
              { path: 'src/workflow.test.ts', additions: 18, deletions: 0 },
            ],
          },
        };
      }
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('queued');
    expect(result.queries.find(query => query.args[0] === 'pr' && query.args[1] === 'list')!.args)
      .toEqual([
        'pr', 'list', '--repo', REPO, '--state', 'merged',
        '--json', 'number,title,author,mergedAt', '--limit', '20',
      ]);
    expect(result.queries.find(query => query.args[0] === 'pr' && query.args[1] === 'view')!.args)
      .toEqual(['pr', 'view', '42', '--repo', REPO, '--json', 'body,commits,files']);

    const pr = (githubContext(result.jobs[0]).merged_prs as Array<Record<string, unknown>>)[0];
    expect(pr.body).toBe(body.replace(/\r\n/g, '\n').trim());
    expect(pr.commits).toEqual([
      'Add customer workflow\n\nPreserve the complete rationale.\nSecond line.',
    ]);
    expect(pr.files).toEqual([
      'src/workflow.ts (+31/-4)',
      'src/workflow.test.ts (+18/-0)',
    ]);
    expect(JSON.stringify(pr)).not.toContain('SECRET DIFF CONTENT');
  });

  it('falls back to name-only diff only when detail files have no stable filenames', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return { ok: true, value: [{ number: 8, mergedAt: NOW }] };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { ok: true, value: { body: 'Body', commits: [], files: [{ additions: 2, deletions: 1 }] } };
      }
      if (args[0] === 'pr' && args[1] === 'diff') {
        return { ok: true, value: 'src/one.ts\nsrc/two.ts\n' };
      }
      return successfulDefaults(args);
    } });

    expect(result.queries.find(query => query.args[0] === 'pr' && query.args[1] === 'diff')!.args)
      .toEqual(['pr', 'diff', '8', '--repo', REPO, '--name-only']);
    const pr = (githubContext(result.jobs[0]).merged_prs as Array<Record<string, unknown>>)[0];
    expect(pr.files).toEqual(['src/one.ts', 'src/two.ts']);
  });

  it('does not fetch a diff when stable file pointers are available', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return { ok: true, value: [{ number: 9, mergedAt: NOW }] };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { ok: true, value: { body: '', commits: [], files: [{ path: 'src/stable.ts' }] } };
      }
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('queued');
    expect(result.queries.some(query => query.args[0] === 'pr' && query.args[1] === 'diff')).toBe(false);
  });
});

describe('GitHub release retrieval', () => {
  it('uses supported list metadata and views bodies for newly discovered tags only', async () => {
    const result = await poll({
      state: { last_polled_at: null, processed_pr_ids: [], processed_release_tags: [`${REPO}:v1`] },
      respond: (args) => {
        if (args[0] === 'release' && args[1] === 'list') {
          return releases(
            { tagName: 'v1', name: 'old', publishedAt: NOW },
            { tagName: 'v2', name: 'new', publishedAt: NOW },
          );
        }
        if (args[0] === 'release' && args[1] === 'view') {
          return { ok: true, value: { body: 'Meaningful release notes for customers.' } };
        }
        return successfulDefaults(args);
      },
    });

    const list = result.queries.find(query => query.args[0] === 'release' && query.args[1] === 'list')!;
    expect(list.args).toEqual([
      'release', 'list', '--repo', REPO,
      '--json', 'tagName,name,publishedAt', '--limit', '5',
    ]);
    const views = result.queries.filter(query => query.args[0] === 'release' && query.args[1] === 'view');
    expect(views.map(query => query.args)).toEqual([
      ['release', 'view', 'v2', '--repo', REPO, '--json', 'body'],
    ]);
  });

  it('preserves the complete fetched body in queued GitHub context', async () => {
    const body = 'Feature details\n\n- Added audit logs\n- Fixed exports';
    const result = await poll({ respond: (args) => {
      if (args[0] === 'release' && args[1] === 'list') return releases({ tagName: 'v2', publishedAt: NOW });
      if (args[0] === 'release' && args[1] === 'view') return { ok: true, value: { body } };
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('queued');
    const context = githubContext(result.jobs[0]);
    expect(context.releases).toEqual([{ tagName: 'v2', publishedAt: NOW, body, repo: REPO }]);
    expect(context.new_release_tags).toEqual([`${REPO}:v2`]);
  });
});

describe('GitHub partial failure and retry behavior', () => {
  it('leaves a PR unacknowledged and fixes the watermark when detail retrieval fails', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return { ok: true, value: [{ number: 77, mergedAt: NOW }] };
      }
      if (args[0] === 'pr' && args[1] === 'view') return { ok: false };
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('partial-failure');
    expect(result.jobs).toHaveLength(0);
    expect(result.watermarks).toHaveLength(0);
  });

  it('queues other evidence but does not acknowledge a PR whose detail fallback fails', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return { ok: true, value: [
          { number: 1, mergedAt: NOW },
          { number: 2, mergedAt: NOW },
        ] };
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '1') {
        return { ok: true, value: { body: 'Good', commits: [], files: [{ path: 'good.ts' }] } };
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { ok: true, value: { body: 'Retry', commits: [], files: [] } };
      }
      if (args[0] === 'pr' && args[1] === 'diff') return { ok: false };
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('queued');
    const context = githubContext(result.jobs[0]);
    expect(context.new_pr_ids).toEqual([`${REPO}:1`]);
    expect(context.advance_watermark).toBe(false);
  });

  it('does not advance state when release listing fails', async () => {
    const result = await poll({ respond: (args) =>
      args[0] === 'release' && args[1] === 'list'
        ? { ok: false }
        : successfulDefaults(args),
    });

    expect(result.outcome).toBe('partial-failure');
    expect(result.jobs).toHaveLength(0);
    expect(result.watermarks).toHaveLength(0);
  });

  it('leaves a tag unacknowledged and watermark fixed when body retrieval fails', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'release' && args[1] === 'list') return releases({ tagName: 'v3', publishedAt: NOW });
      if (args[0] === 'release' && args[1] === 'view') return { ok: false };
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('partial-failure');
    expect(result.jobs).toHaveLength(0);
    expect(result.suppressed).toHaveLength(0);
    expect(result.watermarks).toHaveLength(0);
  });

  it('queues successful mixed PR/release data but disables watermark advancement after another body failure', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return { ok: true, value: [{ number: 42, title: 'Ship it', mergedAt: NOW }] };
      }
      if (args[0] === 'release' && args[1] === 'list') {
        return releases(
          { tagName: 'v-good', publishedAt: NOW },
          { tagName: 'v-retry', publishedAt: NOW },
        );
      }
      if (args[0] === 'release' && args[1] === 'view' && args[2] === 'v-good') {
        return { ok: true, value: { body: 'A substantial set of user-visible improvements.' } };
      }
      if (args[0] === 'release' && args[1] === 'view') return { ok: false };
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('queued');
    const context = githubContext(result.jobs[0]);
    expect(context.new_pr_ids).toEqual([`${REPO}:42`]);
    expect(context.new_release_tags).toEqual([`${REPO}:v-good`]);
    expect(context.advance_watermark).toBe(false);
  });
});

describe('blank release suppression', () => {
  it('suppresses and acknowledges a blank release-only poll', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'release' && args[1] === 'list') return releases({ tagName: 'v-empty', publishedAt: NOW });
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('suppressed');
    expect(result.jobs).toHaveLength(0);
    expect(result.suppressed).toEqual([{
      tags: [`${REPO}:v-empty`], timestamp: NOW, advance: true,
    }]);
  });

  it('acknowledges every blank or whitespace-only release deterministically', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'release' && args[1] === 'list') {
        return releases(
          { tagName: 'v1', publishedAt: NOW },
          { tagName: 'v2', publishedAt: NOW },
        );
      }
      if (args[0] === 'release' && args[1] === 'view' && args[2] === 'v2') {
        return { ok: true, value: { body: '  \n\t ' } };
      }
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('suppressed');
    expect(result.suppressed[0].tags).toEqual([`${REPO}:v1`, `${REPO}:v2`]);
  });

  it('queues a release with short but nonblank notes', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'release' && args[1] === 'list') {
        return releases({ tagName: 'v-hotfix', publishedAt: NOW });
      }
      if (args[0] === 'release' && args[1] === 'view') {
        return { ok: true, value: { body: 'Hotfix' } };
      }
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('queued');
    expect(result.jobs).toHaveLength(1);
    expect(result.suppressed).toHaveLength(0);
    expect((githubContext(result.jobs[0]).releases as Array<Record<string, unknown>>)[0].body)
      .toBe('Hotfix');
  });

  it('does not suppress a blank release when a merged PR also triggered the job', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return { ok: true, value: [{ number: 7, mergedAt: NOW }] };
      }
      if (args[0] === 'release' && args[1] === 'list') return releases({ tagName: 'v-empty', publishedAt: NOW });
      return successfulDefaults(args);
    } });

    expect(result.outcome).toBe('queued');
    expect(result.jobs).toHaveLength(1);
    expect(result.suppressed).toHaveLength(0);
  });
});

describe('GitHub state and queue shape', () => {
  it('recovers malformed state and writes suppressed acknowledgments atomically', async () => {
    mkdirSync(ROOT, { recursive: true });
    const statePath = join(ROOT, 'github.json');
    writeFileSync(statePath, '{not-json');
    expect(await readGitHubState(statePath)).toEqual(defaultState());

    await acknowledgeSuppressedReleases(statePath, [`${REPO}:v1`, `${REPO}:v2`], NOW, true);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      last_polled_at: NOW,
      processed_pr_ids: [],
      processed_release_tags: [`${REPO}:v1`, `${REPO}:v2`],
    });
  });

  it('queues the complete durable job contract', async () => {
    const result = await poll({ respond: (args) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('merged')) {
        return { ok: true, value: [{ number: 9, title: 'New workflow', body: 'Details', mergedAt: NOW }] };
      }
      return successfulDefaults(args);
    } });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      source: 'github',
      profile: 'test',
      timestamp: NOW,
      reason: 'scheduled_poll',
      github_context: {
        type: 'github',
        profile: 'test',
        timestamp: NOW,
        repos: [REPO],
        new_pr_ids: [`${REPO}:9`],
        new_release_tags: [],
        advance_watermark: true,
      },
    });
  });
});
