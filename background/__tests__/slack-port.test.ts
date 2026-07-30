import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildSlackPrompt, extractDescription, readPending, runSlackSynthesis } from '../synthesizers/slack';
import { createContextSnapshot } from '../synthesizers/synthesis-runtime';
import { createSlackAnalyzer, parseSlackRuntimeConfig } from '../integrations/slack/slack-analyzer';

const ROOT = `/tmp/draft-slack-port-test-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('Slack on-device prompt parsing', () => {
  it('extracts folded frontmatter descriptions and injects pending proposals', () => {
    const workspace = join(ROOT, 'workspace'); const index = join(workspace, 'context', 'product', 'index.md'); const reconstructed = join(ROOT, 'product', 'day.md');
    mkdirSync(join(workspace, 'proposals'), { recursive: true }); mkdirSync(join(ROOT, 'product'), { recursive: true }); mkdirSync(join(workspace, 'context', 'product'), { recursive: true });
    writeFileSync(index, '---\ndescription: >\n  Product direction\n  for teammates\nlast_updated: x\n---\n'); writeFileSync(reconstructed, 'messages');
    writeFileSync(join(workspace, 'proposals', '20260101T000000Z-slack.md'), '---\ntimestamp: 2026-01-01T00:00:00Z\n---\nold');
    expect(extractDescription(readFileSync(index, 'utf8'))).toBe('Product direction for teammates');
    const snapshot = createContextSnapshot(workspace);
    const prompt = buildSlackPrompt({ analysis_window_hours: 8, reconstructed_files: [reconstructed] }, { workspace, profile: 'p', currentTimestamp: 'now', intelligence: 'fake', outputPath: '/out', snapshot });
    expect(prompt).toContain('20260101T000000Z-slack.md');
    expect(prompt).toContain(snapshot.files[0].snapshotPath);
    expect(prompt).toContain('base_sha256:');
    expect(prompt).not.toContain('context_updates');
    expect(prompt).not.toContain('replaces_proposal:');
  });

  it('uses legacy empty descriptions and isolates unreadable pending proposals', () => {
    expect(extractDescription('no frontmatter')).toBe('');
    const workspace = join(ROOT, 'workspace'); const proposals = join(workspace, 'proposals'); mkdirSync(proposals, { recursive: true });
    const old = '20260101T000000Z-slack.md'; const latest = '20260102T000000Z-slack.md'; writeFileSync(join(proposals, old), 'old readable'); writeFileSync(join(proposals, latest), 'body timestamp: fake');
    const pending = readPending(workspace, path => path.endsWith(old) ? readFileSync(path, 'utf8') : (() => { throw new Error('denied'); })());
    expect(pending.content).toContain('old readable'); expect(pending.content).toContain(`### ${latest}\n(unreadable)`); expect(pending.latestTimestamp).toBe('(no prior synthesis)');
    writeFileSync(join(proposals, latest), 'body timestamp: 2099\n---\ntimestamp: also-wrong\n---');
    expect(readPending(workspace).latestTimestamp).toBe('(no prior synthesis)');
  });

  it('renders Slack evidence with the shared immutable contract', () => {
    const workspace = join(ROOT, 'workspace'); const channel = join(ROOT, 'product', 'day.md'); mkdirSync(dirname(channel), { recursive: true }); mkdirSync(join(workspace, 'context', 'product'), { recursive: true });
    writeFileSync(channel, 'messages'); writeFileSync(join(workspace, 'context', 'product', 'index.md'), '---\ndescription: Product\n---\n');
    const snapshot = createContextSnapshot(workspace);
    const prompt = buildSlackPrompt({ analysis_window_hours: 8, reconstructed_files: [channel] }, { workspace, profile: 'p', currentTimestamp: 'now', intelligence: 'fake', outputPath: '/out', snapshot });
    expect(prompt).toContain(channel);
    expect(prompt).toContain(snapshot.files[0].sha256);
    expect(prompt).toContain('outcome: rewrite');
    expect(prompt).toContain('needs_input');
  });

  it('rejects direct synthesis without reconstructed files', async () => {
    await expect(runSlackSynthesis({}, { workspace: ROOT })).rejects.toThrow('no reconstructed_files');
    await expect(runSlackSynthesis({ reconstructed_files: [] }, { workspace: ROOT })).rejects.toThrow('no reconstructed_files');
    await expect(runSlackSynthesis({ reconstructed_files: ['  '] }, { workspace: ROOT })).rejects.toThrow('no reconstructed_files');
  });

  it('runs direct synthesis through a fully faked intelligence boundary', async () => {
    const workspace = join(ROOT, 'workspace'); const rebuilt = join(ROOT, 'product', 'day.md'); mkdirSync(dirname(rebuilt), { recursive: true }); writeFileSync(rebuilt, 'messages');
    const files = new Map<string, string>(); let prompt = ''; const previous = process.env.DRAFT_SLACK_INTELLIGENCE; process.env.DRAFT_SLACK_INTELLIGENCE = 'fake';
    try {
      const output = await runSlackSynthesis({ profile: 'p', reconstructed_files: [rebuilt] }, { workspace, backgroundDir: '/bg', now: new Date('2026-01-01T00:00:00Z'), deps: {
        async invoke(input) { prompt = input.prompt; files.set(input.outputPath, '---\noutcome: no_change\n---\n'); return 0; }, makeTemp: () => '/prompt',
        readFile: path => files.get(path)!, writeFile: (path, value) => { files.set(path, value); }, removeFile: path => { files.delete(path); }, exists: path => path === '/bg/intelligence/fake.sh' || files.has(path),
      }});
      expect(output).toContain('outcome: no_change'); expect(prompt).toContain(rebuilt); expect(prompt).toContain('Choose exactly one outcome');
    } finally { if (previous === undefined) delete process.env.DRAFT_SLACK_INTELLIGENCE; else process.env.DRAFT_SLACK_INTELLIGENCE = previous; }
  });

  it('keeps source relevance rules and removes the replacement contract', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(workspace, { recursive: true });
    const prompt = buildSlackPrompt({}, { workspace, profile: 'p', currentTimestamp: 'now', intelligence: 'fake', outputPath: '/out', snapshot: createContextSnapshot(workspace) });
    for (const phrase of ['**SIGNAL — capture:**', '**NOISE — skip:**', 'Do NOT invent information', 'outcome: no_change']) {
      expect(prompt).toContain(phrase);
    }
    expect(prompt).not.toContain('replaces_proposal');
  });
});

describe('Slack analyzer orchestration', () => {
  it('parses multi-channel mappings and defaults malformed config/window safely', () => {
    expect(parseSlackRuntimeConfig({ slack_allowlist_channels: [' C1 ', 3, '', 'C2'] }, { __channels: { C1: 'product', C2: 'eng', bad: 2 } }, 'bad')).toEqual({ channels: ['C1', 'C2'], channelNames: { C1: 'product', C2: 'eng' }, hours: 8 });
    expect(parseSlackRuntimeConfig('bad', null, -1)).toEqual({ channels: [], channelNames: {}, hours: 8 });
  });

  it('passes every channel mapping through rebuild', async () => {
    const calls: unknown[] = [];
    const analyzer = createSlackAnalyzer({ workspace: ROOT, profile: 'p', channels: ['C1', 'C2'], channelNames: { C1: 'product', C2: 'eng' }, hours: 4 }, {
      rebuild: async input => { calls.push(input); return null; }, synthesize: async () => '', exists: () => false, write: () => {}, now: () => new Date(),
    });
    expect(await analyzer()).toBe('empty'); expect(calls).toEqual([{ channel: 'C1', channelName: 'product', hours: 4 }, { channel: 'C2', channelName: 'eng', hours: 4 }]);
  });
  it('routes rewrites to automatic apply and rejects overlap', async () => {
    const workspace = join(ROOT, 'workspace'); const rebuilt = join(ROOT, 'rebuilt.md');
    mkdirSync(workspace, { recursive: true }); writeFileSync(rebuilt, 'messages');
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const writes: string[] = []; const logs: string[] = [];
    const analyzer = createSlackAnalyzer({ workspace, profile: 'p', channels: ['C1'], hours: 8 }, {
      rebuild: async () => rebuilt,
      async synthesize() { await gate; return validRewrite(); },
      exists: path => path === rebuilt, write: path => { writes.push(path); },
      route: () => ({ status: 'success', outcome: 'rewrite', flaggedPath: null, meetingIds: [] }),
      now: () => new Date('2026-01-02T00:00:00Z'), log: (_level, message) => { logs.push(message); },
    });
    const first = analyzer(); expect(await analyzer()).toBe('overlap'); release(); expect(await first).toBe('applied'); expect(writes).toEqual([]); expect(logs.some(message => message.startsWith('starting analysis'))).toBe(true); expect(logs.some(message => message.startsWith('rebuilt C1'))).toBe(true); expect(logs.some(message => message.startsWith('context updated'))).toBe(true);
  });

  it('stages needs-input through the handler without replacement writes', async () => {
    const workspace = join(ROOT, 'workspace'); const rebuilt = join(ROOT, 'rebuilt.md'); mkdirSync(ROOT, { recursive: true }); writeFileSync(rebuilt, 'x'); const writes: string[] = [];
    const analyzer = createSlackAnalyzer({ workspace, profile: 'p', channels: ['C'], hours: 1 }, { rebuild: async () => rebuilt,
      synthesize: async () => '---\noutcome: needs_input\nneeds_input_reason: "Two named Slack decisions conflict."\n---', exists: path => path === rebuilt,
      write: path => { writes.push(path); },
      route: () => ({ status: 'flagged', outcome: 'needs_input', flaggedPath: '/flagged.md', meetingIds: [] }),
      now: () => new Date('2026-01-02T00:00:00Z') });
    expect(await analyzer()).toBe('flagged'); expect(writes).toEqual([]);
  });

  it('defers without writing anything when the workspace is locked', async () => {
    const workspace = join(ROOT, 'workspace'); const rebuilt = join(ROOT, 'rebuilt.md');
    mkdirSync(workspace, { recursive: true }); writeFileSync(rebuilt, 'messages');
    const writes: string[] = [];
    const analyzer = createSlackAnalyzer({ workspace, profile: 'p', channels: ['C1'], hours: 8 }, {
      rebuild: async () => rebuilt, synthesize: async () => validRewrite(),
      exists: path => path === rebuilt, write: path => { writes.push(path); },
      route: () => ({ status: 'locked', outcome: 'rewrite', flaggedPath: null, meetingIds: [] }),
      now: () => new Date('2026-01-02T00:00:00Z'),
    });
    expect(await analyzer()).toBe('deferred');
    expect(writes).toEqual([]);
  });

  it('propagates rebuild/synthesis failures and rejects empty or invalid synthesis safely', async () => {
    const base = { workspace: ROOT, profile: 'p', channels: ['C'], hours: 1 };
    const now = () => new Date('2026-01-01T00:00:00Z');
    await expect(createSlackAnalyzer(base, { rebuild: async () => { throw new Error('rebuild failed'); }, synthesize: async () => '', exists: () => false, write: () => {}, now })()).rejects.toThrow('rebuild failed');
    await expect(createSlackAnalyzer(base, { rebuild: async () => '/rebuilt', synthesize: async () => { throw new Error('synth failed'); }, exists: () => true, write: () => {}, now })()).rejects.toThrow('synth failed');
    await expect(createSlackAnalyzer(base, { rebuild: async () => '/rebuilt', synthesize: async () => '', exists: () => true, write: () => { throw new Error('must not write'); }, now })()).rejects.toThrow('invalid maintainer output');
    await expect(createSlackAnalyzer(base, { rebuild: async () => '/rebuilt', synthesize: async () => 'invalid', exists: () => true, write: () => {}, route: () => { throw new Error('invalid maintainer output'); }, now })()).rejects.toThrow('invalid maintainer output');
  });
});

function validRewrite(): string {
  return `---
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${"a".repeat(64)}
    summary: A specific product decision.
    content: |
      # Product
      A specific product decision.
---`;
}
