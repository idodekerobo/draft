import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildFirefliesPrompt, runFirefliesSynthesis } from '../synthesizers/fireflies';
import { createFirefliesPoller, extractMeetingIds, mergeFirefliesState, readFirefliesState } from '../integrations/fireflies/fireflies-poller';

const ROOT = `/tmp/draft-fireflies-port-test-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('Fireflies prompt', () => {
  it('builds a single-mode MCP prompt with the fireflies tool table and processed-id skip list', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'context', 'product'), { recursive: true }); writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'x');
    const prompt = buildFirefliesPrompt({ workspace, profile: 'p', outputPath: '/out', currentTimestamp: '2026-01-01T00:00:00Z', intelligence: 'fake', context: { processed_meeting_ids: ['done'] } });
    expect(prompt).toContain('`fireflies_get_transcripts`');
    expect(prompt).toContain('`fireflies_get_transcript`');
    expect(prompt).toContain('`fireflies_get_summary`');
    expect(prompt).toContain('  - done');
    expect(prompt).toContain('meeting_ids:');
    expect(prompt).toContain('action: tension');
    expect(prompt).toContain('DO NOT USE in synthesis');
  });

  it('keeps the shared SIGNAL/NOISE/contradiction contract phrases', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(workspace, { recursive: true });
    const prompt = buildFirefliesPrompt({ workspace, profile: 'p', outputPath: '/out', currentTimestamp: 'now', intelligence: 'fake', context: {} });
    const frozen = ['**SIGNAL — capture:**', '**NOISE — skip:**', '**CONTRADICTIONS — use action: tension:**', 'Never overwrite to resolve a contradiction', 'Do NOT invent information'];
    for (const phrase of frozen) expect(prompt).toContain(phrase);
  });

  it('runs synthesis with fully faked intelligence boundaries', async () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'config'), { recursive: true });
    const files = new Map<string, string>(); let prompt = ''; const previous = process.env.DRAFT_FIREFLIES_INTELLIGENCE; process.env.DRAFT_FIREFLIES_INTELLIGENCE = 'fake';
    try {
      const output = await runFirefliesSynthesis({ profile: 'p', last_checked_at: null }, { workspace, backgroundDir: '/bg', now: new Date('2026-01-02T12:00:00Z'), deps: {
        async invoke(input) { prompt = input.prompt; files.set(input.outputPath, '---\ncontext_updates: []\n---\n'); return 0; }, makeTemp: () => '/prompt',
        readFile: path => files.get(path)!, writeFile: (path, value) => { files.set(path, value); }, removeFile: path => { files.delete(path); }, exists: path => path === '/bg/intelligence/fake.sh' || files.has(path),
      }});
      expect(output).toContain('context_updates: []');
      expect(prompt).toContain('fireflies_get_transcripts');
    } finally { if (previous === undefined) delete process.env.DRAFT_FIREFLIES_INTELLIGENCE; else process.env.DRAFT_FIREFLIES_INTELLIGENCE = previous; }
  });
});

describe('Fireflies state and orchestration', () => {
  it('round-trips malformed/default state and deduplicates meeting IDs', () => {
    const statePath = join(ROOT, 'state.json'); mkdirSync(ROOT, { recursive: true }); writeFileSync(statePath, 'bad');
    expect(readFirefliesState(statePath)).toEqual({ last_checked_at: null, processed_meeting_ids: [] });
    expect(mergeFirefliesState({ last_checked_at: null, processed_meeting_ids: ['a'] }, 'now', ['a', 'b']).processed_meeting_ids).toEqual(['a', 'b']);
    expect(extractMeetingIds('---\nmeeting_ids:\n  - a\n  - b\ncontext_updates: []\n---')).toEqual(['a', 'b']);
  });

  it('skips the poll when the api token is missing', async () => {
    let called = false;
    const poll = createFirefliesPoller({ statePath: join(ROOT, 'state.json'), workspace: ROOT, profile: 'p' }, {
      verifyMcp: async () => { called = true; return true; }, synthesize: async () => { called = true; return ''; }, write: () => { called = true; }, now: () => new Date(),
    });
    expect(await poll()).toBe('skipped');
    expect(called).toBe(false);
  });

  it('skips the poll when the MCP server is not registered', async () => {
    const poll = createFirefliesPoller({ statePath: join(ROOT, 'state.json'), workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => false, synthesize: async () => { throw new Error('should not be called'); }, write: () => {}, now: () => new Date(),
    });
    expect(await poll()).toBe('skipped');
  });

  it('stages proposals, advances state on empty, and rejects overlap', async () => {
    const statePath = join(ROOT, 'state.json'); const workspace = join(ROOT, 'workspace'); const writes = new Map<string, string>(); const logs: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const poll = createFirefliesPoller({ statePath, workspace, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true,
      async synthesize() { await gate; return '---\nmeeting_ids:\n  - meet-1\ncontext_updates:\n  - file: context/product/index.md\n    action: append\n    content: |\n      A specific product decision.\n---'; },
      write(path, content) { writes.set(path, content); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, { flag: 'w' }); },
      now: () => new Date('2026-01-02T12:00:00Z'), log: (_level, message) => { logs.push(message); },
    });
    mkdirSync(ROOT, { recursive: true }); const first = poll(); expect(await poll()).toBe('overlap'); release(); expect(await first).toBe('staged');
    const order = [...writes.keys()]; expect(order[0]).toEndWith('20260102T120000Z-fireflies.md'); expect(order[1]).toBe(statePath);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).processed_meeting_ids).toEqual(['meet-1']);
    expect(logs.some(message => message.startsWith('starting poll'))).toBe(true); expect(logs.some(message => message.startsWith('staged at'))).toBe(true); expect(logs.some(message => message.startsWith('state updated'))).toBe(true);
  });

  it('advances state for true empty output and valid no-update output', async () => {
    for (const output of ['', '---\ncontext_updates: []\n---\n']) {
      const writes = new Map<string, string>(); const statePath = join(ROOT, crypto.randomUUID(), 'state.json');
      const poll = createFirefliesPoller({ statePath, workspace: ROOT, profile: 'p', token: 'secret' }, {
        verifyMcp: async () => true, synthesize: async () => output, write: (path, content) => { writes.set(path, content); }, now: () => new Date('2026-02-01T00:00:00Z'),
      });
      expect(await poll()).toBe('empty'); expect(JSON.parse(writes.get(statePath)!).last_checked_at).toBe('2026-02-01T00:00:00Z');
    }
  });

  it('does not advance state when synthesis output is invalid', async () => {
    const writes: string[] = [];
    const poll = createFirefliesPoller({ statePath: join(ROOT, 'state.json'), workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true, synthesize: async () => 'not frontmatter', write: path => { writes.push(path); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await expect(poll()).rejects.toThrow('invalid automated synthesis output');
    expect(writes).toEqual([]);
  });

  it('does not advance state when proposal staging fails', async () => {
    const statePath = join(ROOT, 'state.json'); const proposalWrites: string[] = [];
    const poll = createFirefliesPoller({ statePath, workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true, synthesize: async () => validUpdate('meet-1'),
      write(path) { proposalWrites.push(path); if (path.includes('/proposals/')) throw new Error('disk full'); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await expect(poll()).rejects.toThrow('disk full'); expect(proposalWrites).toHaveLength(1); expect(proposalWrites[0]).toContain('/proposals/');
  });
});

function validUpdate(id: string): string { return `---\nmeeting_ids:\n  - ${id}\ncontext_updates:\n  - file: context/product/index.md\n    action: append\n    content: |\n      A specific product decision.\n---`; }
