import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildSlackPrompt, extractDescription, readPending, readReplacesProposal, runSlackSynthesis, safeReplacementPath } from '../synthesizers/slack';
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
    const prompt = buildSlackPrompt({ analysis_window_hours: 8, reconstructed_files: [reconstructed] }, { workspace, profile: 'p', currentTimestamp: 'now', intelligence: 'fake' });
    expect(prompt).toContain('20260101T000000Z-slack.md'); expect(prompt).toContain('action: tension'); expect(prompt).toContain('DO NOT USE in context_updates');
  });

  it('allows only existing bare proposal filenames in the established convention', () => {
    const dir = join(ROOT, 'proposals'); mkdirSync(dir, { recursive: true }); const good = '20260101T010203Z-slack.md'; writeFileSync(join(dir, good), 'x');
    expect(safeReplacementPath(dir, good)).toBe(join(dir, good));
    for (const bad of ['../' + good, `sub/${good}`, '..', 'notes.md', '20260101T010203Z-slack.md/..']) expect(safeReplacementPath(dir, bad)).toBeNull();
    expect(readReplacesProposal(`---\nreplaces_proposal: ${good}\n---`)).toBe(good);
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

  it('matches the complete normalized Slack prompt golden', () => {
    const workspace = join(ROOT, 'workspace'); const channel = join(ROOT, 'product', 'day.md'); mkdirSync(dirname(channel), { recursive: true }); mkdirSync(join(workspace, 'context', 'product'), { recursive: true });
    writeFileSync(channel, 'messages'); writeFileSync(join(workspace, 'context', 'product', 'index.md'), '---\ndescription: Product\n---\n');
    const prompt = buildSlackPrompt({ analysis_window_hours: 8, reconstructed_files: [channel] }, { workspace, profile: 'p', currentTimestamp: 'now', intelligence: 'fake' });
    const normalized = prompt.replaceAll(workspace, '<WORKSPACE>').replaceAll(ROOT, '<ROOT>');
    expect(createHash('sha256').update(normalized).digest('hex')).toBe('d6dcb18e284b343ebe17c4555f8ea4e6e36726c8197ecf35e6be59b8f9eeba71');
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
        async invoke(input) { prompt = input.prompt; files.set(input.outputPath, '---\ncontext_updates: []\n---\n'); return 0; }, makeTemp: () => '/prompt',
        readFile: path => files.get(path)!, writeFile: (path, value) => { files.set(path, value); }, removeFile: path => { files.delete(path); }, exists: path => path === '/bg/intelligence/fake.sh' || files.has(path),
      }});
      expect(output).toContain('context_updates: []'); expect(prompt).toContain(rebuilt); expect(prompt).toContain('empty context_updates');
    } finally { if (previous === undefined) delete process.env.DRAFT_SLACK_INTELLIGENCE; else process.env.DRAFT_SLACK_INTELLIGENCE = previous; }
  });

  it('keeps committed legacy append/tension and relevance contract sections', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(workspace, { recursive: true });
    const prompt = buildSlackPrompt({}, { workspace, profile: 'p', currentTimestamp: 'now', intelligence: 'fake' });
    for (const phrase of ['**SIGNAL — capture:**', '**NOISE — skip:**', '**CONTRADICTIONS — use action: tension:**', 'Do NOT invent information', 'replaces_proposal must be an exact filename']) {
      expect(prompt).toContain(phrase);
    }
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
  it('replaces a safe existing proposal and rejects overlap', async () => {
    const workspace = join(ROOT, 'workspace'); const proposals = join(workspace, 'proposals'); const rebuilt = join(ROOT, 'rebuilt.md'); const existing = join(proposals, '20260101T010203Z-slack.md');
    mkdirSync(proposals, { recursive: true }); writeFileSync(rebuilt, 'messages'); writeFileSync(existing, 'old');
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const writes: string[] = []; const logs: string[] = [];
    const analyzer = createSlackAnalyzer({ workspace, profile: 'p', channels: ['C1'], hours: 8 }, {
      rebuild: async () => rebuilt,
      async synthesize() { await gate; return '---\nreplaces_proposal: 20260101T010203Z-slack.md\ncontext_updates:\n  - file: context/product/index.md\n    action: append\n    content: |\n      A specific product decision.\n---'; },
      exists: path => path === rebuilt || path === existing, write: path => { writes.push(path); }, now: () => new Date('2026-01-02T00:00:00Z'), log: (_level, message) => { logs.push(message); },
    });
    const first = analyzer(); expect(await analyzer()).toBe('overlap'); release(); expect(await first).toBe('replaced'); expect(writes).toEqual([existing]); expect(logs.some(message => message.startsWith('starting analysis'))).toBe(true); expect(logs.some(message => message.startsWith('rebuilt C1'))).toBe(true); expect(logs.some(message => message.startsWith('overwrote existing proposal'))).toBe(true);
  });

  it('creates a new proposal when replacement is traversal or missing', async () => {
    const workspace = join(ROOT, 'workspace'); const rebuilt = join(ROOT, 'rebuilt.md'); mkdirSync(ROOT, { recursive: true }); writeFileSync(rebuilt, 'x'); const writes: string[] = [];
    const analyzer = createSlackAnalyzer({ workspace, profile: 'p', channels: ['C'], hours: 1 }, { rebuild: async () => rebuilt,
      synthesize: async () => '---\nreplaces_proposal: ../../owned.md\ncontext_updates:\n  - file: context/product/index.md\n    action: append\n    content: |\n      A specific product decision.\n---', exists: path => path === rebuilt,
      write: path => { writes.push(path); }, now: () => new Date('2026-01-02T00:00:00Z') });
    expect(await analyzer()).toBe('staged'); expect(writes[0]).toBe(join(workspace, 'proposals', '20260102T000000Z-slack.md'));
  });

  it('propagates rebuild/synthesis failures and rejects empty or invalid synthesis safely', async () => {
    const base = { workspace: ROOT, profile: 'p', channels: ['C'], hours: 1 };
    const now = () => new Date('2026-01-01T00:00:00Z');
    await expect(createSlackAnalyzer(base, { rebuild: async () => { throw new Error('rebuild failed'); }, synthesize: async () => '', exists: () => false, write: () => {}, now })()).rejects.toThrow('rebuild failed');
    await expect(createSlackAnalyzer(base, { rebuild: async () => '/rebuilt', synthesize: async () => { throw new Error('synth failed'); }, exists: () => true, write: () => {}, now })()).rejects.toThrow('synth failed');
    expect(await createSlackAnalyzer(base, { rebuild: async () => '/rebuilt', synthesize: async () => '', exists: () => true, write: () => { throw new Error('must not write'); }, now })()).toBe('empty');
    await expect(createSlackAnalyzer(base, { rebuild: async () => '/rebuilt', synthesize: async () => 'invalid', exists: () => true, write: () => {}, now })()).rejects.toThrow('invalid automated synthesis output');
  });
});
