import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { openActivityDb, queryRuns, type ActivityRun } from 'draft-core/db/activity';
import { createFirefliesPoller } from '../integrations/fireflies/fireflies-poller';
import { createGranolaPoller } from '../integrations/granola/granola-poller';
import { createSlackAnalyzer } from '../integrations/slack/slack-analyzer';

const ROOT = `/tmp/draft-terminal-activity-test-${process.pid}`;
const NOW = new Date('2026-07-29T12:34:56.789Z');

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function activityRows(workspace: string): ActivityRun[] {
  mkdirSync(workspace, { recursive: true });
  const db = openActivityDb(workspace);
  try { return queryRuns(db); } finally { db.close(); }
}

describe('poller and analyzer terminal activity', () => {
  it('maps applied, flagged, and empty to one terminal row with the route job ID', async () => {
    const workspace = join(ROOT, 'terminal');
    const granola = createGranolaPoller({
      statePath: join(ROOT, 'granola.json'), workspace, profile: 'team', mode: 'mcp',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => 'output',
      route: () => ({ status: 'success', outcome: 'rewrite', flaggedPath: null, meetingIds: [] }),
      write: () => {},
      now: () => NOW,
    });
    const fireflies = createFirefliesPoller({
      statePath: join(ROOT, 'fireflies.json'), workspace, profile: 'team', token: 'token',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => 'output',
      route: () => ({ status: 'flagged', outcome: 'needs_input', flaggedPath: '/flagged.md', meetingIds: [] }),
      write: () => {},
      now: () => NOW,
    });
    const slack = createSlackAnalyzer({
      workspace, profile: 'team', channels: ['C1'], hours: 8,
    }, {
      rebuild: async () => null,
      synthesize: async () => { throw new Error('not called'); },
      exists: () => false,
      write: () => {},
      now: () => NOW,
    });

    expect(await granola()).toBe('applied');
    expect(await fireflies()).toBe('flagged');
    expect(await slack()).toBe('empty');

    expect(activityRows(workspace)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'granola:2026-07-29T12:34:56Z',
        source: 'granola',
        status: 'success',
        proposalsGenerated: 0,
        maintainerOutcome: 'rewrite',
      }),
      expect.objectContaining({
        id: 'fireflies:2026-07-29T12:34:56Z',
        source: 'fireflies',
        status: 'success',
        proposalsGenerated: 1,
        maintainerOutcome: 'needs_input',
      }),
      expect.objectContaining({
        id: 'slack:2026-07-29T12:34:56Z',
        source: 'slack',
        status: 'success',
        proposalsGenerated: 0,
        maintainerOutcome: 'no_change',
      }),
    ]));
    expect(activityRows(workspace)).toHaveLength(3);
  });

  it('records exceptions as failed and rethrows them for every integration', async () => {
    const workspace = join(ROOT, 'failed');
    const granola = createGranolaPoller({
      statePath: join(ROOT, 'granola.json'), workspace, profile: 'team', mode: 'mcp',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => 'output',
      route: () => { throw new Error('granola failed'); },
      write: () => {},
      now: () => NOW,
    });
    const fireflies = createFirefliesPoller({
      statePath: join(ROOT, 'fireflies.json'), workspace, profile: 'team', token: 'token',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => { throw new Error('fireflies failed'); },
      write: () => {},
      now: () => NOW,
    });
    const slack = createSlackAnalyzer({
      workspace, profile: 'team', channels: ['C1'], hours: 8,
    }, {
      rebuild: async () => { throw new Error('slack failed'); },
      synthesize: async () => '',
      exists: () => false,
      write: () => {},
      now: () => NOW,
    });

    await expect(granola()).rejects.toThrow('granola failed');
    await expect(fireflies()).rejects.toThrow('fireflies failed');
    await expect(slack()).rejects.toThrow('slack failed');

    expect(activityRows(workspace)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'granola:2026-07-29T12:34:56Z', status: 'failed', errorMsg: 'granola failed', maintainerOutcome: null }),
      expect.objectContaining({ id: 'fireflies:2026-07-29T12:34:56Z', status: 'failed', errorMsg: 'fireflies failed', maintainerOutcome: null }),
      expect.objectContaining({ id: 'slack:2026-07-29T12:34:56Z', status: 'failed', errorMsg: 'slack failed', maintainerOutcome: null }),
    ]));
    expect(activityRows(workspace)).toHaveLength(3);
  });

  it('writes no row for skipped, deferred, overlap, or unconfigured work', async () => {
    const workspace = join(ROOT, 'non-terminal');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const overlapping = createGranolaPoller({
      statePath: join(ROOT, 'overlap.json'), workspace, profile: 'team', mode: 'mcp',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => { await gate; return 'output'; },
      route: () => ({ status: 'locked', outcome: 'rewrite', flaggedPath: null, meetingIds: [] }),
      write: () => {},
      now: () => NOW,
    });
    const first = overlapping();
    expect(await overlapping()).toBe('overlap');
    expect(activityRows(workspace)).toEqual([]);
    release();
    expect(await first).toBe('deferred');

    const skipped = createFirefliesPoller({
      statePath: join(ROOT, 'skipped.json'), workspace, profile: 'team',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => '',
      write: () => {},
      now: () => NOW,
    });
    expect(await skipped()).toBe('skipped');

    const unconfigured = createSlackAnalyzer({
      workspace, profile: 'team', channels: [], hours: 8,
    }, {
      rebuild: async () => { throw new Error('not called'); },
      synthesize: async () => '',
      exists: () => false,
      write: () => {},
      now: () => NOW,
    });
    expect(await unconfigured()).toBe('empty');
    expect(activityRows(workspace)).toEqual([]);
  });
});
