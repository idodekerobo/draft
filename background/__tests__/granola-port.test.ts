import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildGranolaPrompt, filterApiMeetings, formatApiMeetings, parseGranolaMode, runGranolaSynthesis } from '../synthesizers/granola';
import { createGranolaPoller, extractMeetingIds, mergeGranolaState, readGranolaState } from '../integrations/granola/granola-poller';

const ROOT = `/tmp/draft-granola-port-test-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('Granola prompt and API parsing parity', () => {
  it('builds distinct MCP/API prompts while preserving immutable rules', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'context', 'product'), { recursive: true }); writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'x');
    const common = { workspace, profile: 'p', outputPath: '/out', currentTimestamp: '2026-01-01T00:00:00Z', intelligence: 'fake' };
    const mcp = buildGranolaPrompt({ ...common, context: { mode: 'mcp', processed_meeting_ids: ['done'] } });
    const api = buildGranolaPrompt({ ...common, context: { mode: 'api' }, transcriptContent: '=== Demo ===\ntext' });
    expect(mcp).toContain('`list_meetings`'); expect(mcp).toContain('  - done');
    expect(api).toContain('=== Demo ===\ntext'); expect(api).not.toContain('Available Granola MCP tools');
    expect(api).not.toContain('meeting_ids:'); expect(mcp).toContain('meeting_ids:');
    for (const prompt of [mcp, api]) { expect(prompt).toContain('action: tension'); expect(prompt).toContain('DO NOT USE in synthesis'); }
  });

  it('matches complete normalized MCP and API prompt goldens', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'context', 'product'), { recursive: true }); writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'x');
    const base = { workspace, profile: 'p', outputPath: '/out', currentTimestamp: 'now', intelligence: 'fake' };
    const normalize = (prompt: string) => prompt.replaceAll(workspace, '<WORKSPACE>').replaceAll('/out', '<OUTPUT>');
    expect(createHash('sha256').update(normalize(buildGranolaPrompt({ ...base, context: { mode: 'mcp', last_checked_at: 'before', processed_meeting_ids: ['done'] } }))).digest('hex')).toBe('7e9d0fb199a3b38f738f41e71aa6564b5a205f5c17fc684422aab97a9e88f1e2');
    expect(createHash('sha256').update(normalize(buildGranolaPrompt({ ...base, context: { mode: 'api', last_checked_at: 'before' }, transcriptContent: '=== Demo ===\nbody\n' }))).digest('hex')).toBe('d8b42f2a5e37cf7a4e64109f56e7c86f099ea590e1ccfdef139ef898672cb662');
  });

  it('keeps the committed legacy contract golden sections in both TS modes', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(workspace, { recursive: true });
    const base = { workspace, profile: 'p', outputPath: '/out', currentTimestamp: 'now', intelligence: 'fake' };
    const prompts = [buildGranolaPrompt({ ...base, context: { mode: 'mcp' } }), buildGranolaPrompt({ ...base, context: { mode: 'api' }, transcriptContent: 'transcript' })];
    const frozen = ['**SIGNAL — capture:**', '**NOISE — skip:**', '**CONTRADICTIONS — use action: tension:**', 'Never overwrite to resolve a contradiction', 'Do NOT invent information'];
    for (const phrase of frozen) for (const prompt of prompts) expect(prompt).toContain(phrase);
  });

  it('filters incomplete, old and empty API meetings', () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const notes = filterApiMeetings({ notes: [
      { id: 'ok', title: 'Good', transcript: 'signal', created_at: '2026-01-02T11:00:00Z' },
      { id: 'partial', transcript: 'wait', created_at: '2026-01-02T11:45:00Z' },
      { id: 'old', transcript: 'old', created_at: '2025-12-31T00:00:00Z' },
      { id: 'empty', created_at: '2026-01-02T11:00:00Z' },
    ]}, '2026-01-01T00:00:00Z', now);
    expect(notes.map(n => n.id)).toEqual(['ok']); expect(formatApiMeetings(notes)).toContain('=== Good ===');
  });

  it('treats an invalid last_checked_at as no cutoff and falls back from empty transcript to content', () => {
    const notes = filterApiMeetings([{ id: 'x', title: 'Fallback', transcript: '', content: 'content body', created_at: '2020-01-01T00:00:00Z' }], 'not-a-date', new Date('2026-01-02T12:00:00Z'));
    expect(notes.map(note => note.id)).toEqual(['x']);
    expect(formatApiMeetings(notes)).toContain('content body');
  });

  it('rejects invalid modes at builder and runner boundaries', async () => {
    expect(() => parseGranolaMode('bogus')).toThrow('unknown Granola mode');
    expect(() => buildGranolaPrompt({ context: { mode: 'bogus' as never }, workspace: ROOT, profile: 'p', outputPath: '/out', currentTimestamp: 'now', intelligence: 'fake' })).toThrow('unknown Granola mode');
    await expect(runGranolaSynthesis({ mode: 'bogus' as never }, { workspace: ROOT })).rejects.toThrow('unknown Granola mode');
  });

  it('runs API mode with fully faked fetch and intelligence boundaries', async () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'config'), { recursive: true }); writeFileSync(join(workspace, 'config', 'secrets.json'), JSON.stringify({ granola_api_token: 'secret' }));
    const files = new Map<string, string>(); let prompt = ''; const previous = process.env.DRAFT_GRANOLA_INTELLIGENCE; process.env.DRAFT_GRANOLA_INTELLIGENCE = 'fake';
    try {
      const output = await runGranolaSynthesis({ mode: 'api', profile: 'p', last_checked_at: 'invalid' }, { workspace, backgroundDir: '/bg', now: new Date('2026-01-02T12:00:00Z'), deps: {
        fetchApi: async token => { expect(token).toBe('secret'); return [{ title: 'Fallback', transcript: '', content: 'content body', created_at: '2026-01-02T11:00:00Z' }]; },
        async invoke(input) { prompt = input.prompt; files.set(input.outputPath, '---\ncontext_updates: []\n---\n'); return 0; }, makeTemp: () => '/prompt',
        readFile: path => files.get(path)!, writeFile: (path, value) => { files.set(path, value); }, removeFile: path => { files.delete(path); }, exists: path => path === '/bg/intelligence/fake.sh' || files.has(path),
      }});
      expect(output).toContain('context_updates: []'); expect(prompt).toContain('content body'); expect(prompt).not.toContain('meeting_ids:');
    } finally { if (previous === undefined) delete process.env.DRAFT_GRANOLA_INTELLIGENCE; else process.env.DRAFT_GRANOLA_INTELLIGENCE = previous; }
  });
});

describe('Granola state and orchestration', () => {
  it('round-trips malformed/default state and deduplicates meeting IDs', () => {
    const statePath = join(ROOT, 'state.json'); mkdirSync(ROOT, { recursive: true }); writeFileSync(statePath, 'bad');
    expect(readGranolaState(statePath)).toEqual({ last_checked_at: null, processed_meeting_ids: [] });
    expect(mergeGranolaState({ last_checked_at: null, processed_meeting_ids: ['a'] }, 'now', ['a', 'b']).processed_meeting_ids).toEqual(['a', 'b']);
    expect(extractMeetingIds('---\nmeeting_ids:\n  - a\n  - b\ncontext_updates: []\n---')).toEqual(['a', 'b']);
  });

  it('stages proposals, advances state on empty, and rejects overlap', async () => {
    const statePath = join(ROOT, 'state.json'); const workspace = join(ROOT, 'workspace'); const writes = new Map<string, string>(); const logs: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const poll = createGranolaPoller({ statePath, workspace, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true,
      async synthesize() { await gate; return '---\nmeeting_ids:\n  - meet-1\ncontext_updates:\n  - file: context/product/index.md\n    action: append\n    content: |\n      A specific product decision.\n---'; },
      write(path, content) { writes.set(path, content); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, { flag: 'w' }); },
      now: () => new Date('2026-01-02T12:00:00Z'), log: (_level, message) => { logs.push(message); },
    });
    mkdirSync(ROOT, { recursive: true }); const first = poll(); expect(await poll()).toBe('overlap'); release(); expect(await first).toBe('staged');
    const order = [...writes.keys()]; expect(order[0]).toEndWith('20260102T120000Z-granola.md'); expect(order[1]).toBe(statePath);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).processed_meeting_ids).toEqual(['meet-1']);
    expect(logs.some(message => message.startsWith('starting poll'))).toBe(true); expect(logs.some(message => message.startsWith('staged at'))).toBe(true); expect(logs.some(message => message.startsWith('state updated'))).toBe(true);
  });

  it('does not advance state when proposal staging fails', async () => {
    const statePath = join(ROOT, 'state.json'); const proposalWrites: string[] = [];
    const poll = createGranolaPoller({ statePath, workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true, synthesize: async () => validUpdate('meet-1'),
      write(path) { proposalWrites.push(path); if (path.includes('/proposals/')) throw new Error('disk full'); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await expect(poll()).rejects.toThrow('disk full'); expect(proposalWrites).toHaveLength(1); expect(proposalWrites[0]).toContain('/proposals/');
  });

  it('advances state for true empty output and valid no-update output', async () => {
    for (const output of ['', '---\ncontext_updates: []\n---\n']) {
      const writes = new Map<string, string>(); const statePath = join(ROOT, crypto.randomUUID(), 'state.json');
      const poll = createGranolaPoller({ statePath, workspace: ROOT, profile: 'p', mode: 'mcp' }, {
        verifyMcp: async () => true, synthesize: async () => output, write: (path, content) => { writes.set(path, content); }, now: () => new Date('2026-02-01T00:00:00Z'),
      });
      expect(await poll()).toBe('empty'); expect(JSON.parse(writes.get(statePath)!).last_checked_at).toBe('2026-02-01T00:00:00Z');
    }
  });

  it('does not advance state when synthesis output is invalid', async () => {
    const writes: string[] = [];
    const poll = createGranolaPoller({ statePath: join(ROOT, 'state.json'), workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true, synthesize: async () => 'not frontmatter', write: path => { writes.push(path); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await expect(poll()).rejects.toThrow('invalid automated synthesis output');
    expect(writes).toEqual([]);
  });

  it('rejects an invalid poller mode before any external work', async () => {
    let called = false;
    const poll = createGranolaPoller({ statePath: '/state', workspace: ROOT, profile: 'p', mode: 'bad' as never }, {
      verifyMcp: async () => { called = true; return true; }, synthesize: async () => { called = true; return ''; }, write: () => { called = true; }, now: () => new Date(),
    });
    await expect(poll()).rejects.toThrow('unknown Granola mode'); expect(called).toBe(false);
  });
});

function validUpdate(id: string): string { return `---\nmeeting_ids:\n  - ${id}\ncontext_updates:\n  - file: context/product/index.md\n    action: append\n    content: |\n      A specific product decision.\n---`; }
