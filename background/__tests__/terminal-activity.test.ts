import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'fs';
import { join } from 'path';
import { createFirefliesPoller } from '../integrations/fireflies/fireflies-poller';
import { createSlackAnalyzer } from '../integrations/slack/slack-analyzer';

const ROOT = `/tmp/draft-terminal-activity-test-${process.pid}`;
const NOW = new Date('2026-07-29T12:34:56.789Z');

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('poller and analyzer terminal outcomes', () => {
  it('maps applied, flagged, and empty to the correct return value', async () => {
    const workspace = join(ROOT, 'terminal');
    const pollerA = createFirefliesPoller({
      statePath: join(ROOT, 'poller-a.json'), workspace, profile: 'team', token: 'token',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => 'output',
      route: () => ({ status: 'success', outcome: 'rewrite', flaggedPath: null, meetingIds: [] }),
      write: () => {},
      now: () => NOW,
    });
    const pollerB = createFirefliesPoller({
      statePath: join(ROOT, 'poller-b.json'), workspace, profile: 'team', token: 'token',
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

    expect(await pollerA()).toBe('applied');
    expect(await pollerB()).toBe('flagged');
    expect(await slack()).toBe('empty');
  });

  it('rethrows exceptions for every integration', async () => {
    const workspace = join(ROOT, 'failed');
    const pollerA = createFirefliesPoller({
      statePath: join(ROOT, 'poller-a.json'), workspace, profile: 'team', token: 'token',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => 'output',
      route: () => { throw new Error('poller failed'); },
      write: () => {},
      now: () => NOW,
    });
    const pollerB = createFirefliesPoller({
      statePath: join(ROOT, 'poller-b.json'), workspace, profile: 'team', token: 'token',
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

    await expect(pollerA()).rejects.toThrow('poller failed');
    await expect(pollerB()).rejects.toThrow('fireflies failed');
    await expect(slack()).rejects.toThrow('slack failed');
  });

  it('returns overlap, deferred, or skipped for non-terminal or unconfigured work', async () => {
    const workspace = join(ROOT, 'non-terminal');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const overlapping = createFirefliesPoller({
      statePath: join(ROOT, 'overlap.json'), workspace, profile: 'team', token: 'token',
    }, {
      verifyMcp: async () => true,
      synthesize: async () => { await gate; return 'output'; },
      route: () => ({ status: 'locked', outcome: 'rewrite', flaggedPath: null, meetingIds: [] }),
      write: () => {},
      now: () => NOW,
    });
    const first = overlapping();
    expect(await overlapping()).toBe('overlap');
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
  });
});
