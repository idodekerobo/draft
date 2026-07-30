import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildGranolaPrompt, filterApiMeetings, formatApiMeetings, parseGranolaMode, runGranolaSynthesis } from '../synthesizers/granola';
import { createContextSnapshot } from '../synthesizers/synthesis-runtime';
import { createGranolaPoller, mergeGranolaState, readGranolaState } from '../integrations/granola/granola-poller';

const ROOT = `/tmp/draft-granola-port-test-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('Granola prompt and API parsing parity', () => {
  it('builds distinct MCP/API prompts while preserving immutable rules', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'context', 'product'), { recursive: true }); writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'x');
    const common = { workspace, profile: 'p', outputPath: '/out', currentTimestamp: '2026-01-01T00:00:00Z', intelligence: 'fake', snapshot: createContextSnapshot(workspace) };
    const mcp = buildGranolaPrompt({ ...common, context: { mode: 'mcp', processed_meeting_ids: ['done'] } });
    const api = buildGranolaPrompt({ ...common, context: { mode: 'api' }, transcriptContent: '=== Demo ===\ntext' });
    expect(mcp).toContain('`list_meetings`'); expect(mcp).toContain('  - done');
    expect(api).toContain('=== Demo ===\ntext'); expect(api).not.toContain('Available Granola MCP tools');
    expect(api).toContain('meeting_ids:'); expect(mcp).toContain('meeting_ids:');
    for (const prompt of [mcp, api]) {
      expect(prompt).toContain('outcome: rewrite');
      expect(prompt).toContain('base_sha256:');
      expect(prompt).not.toContain('context_updates');
    }
  });

  it('renders the same immutable snapshot contract in MCP and API modes', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'context', 'product'), { recursive: true }); writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'x');
    const snapshot = createContextSnapshot(workspace);
    const base = { workspace, profile: 'p', outputPath: '/out', currentTimestamp: 'now', intelligence: 'fake', snapshot };
    for (const prompt of [
      buildGranolaPrompt({ ...base, context: { mode: 'mcp', last_checked_at: 'before', processed_meeting_ids: ['done'] } }),
      buildGranolaPrompt({ ...base, context: { mode: 'api', last_checked_at: 'before' }, transcriptContent: '=== Demo ===\nbody\n' }),
    ]) {
      expect(prompt).toContain(snapshot.files[0].snapshotPath);
      expect(prompt).toContain(snapshot.files[0].sha256);
    }
  });

  it('keeps source-specific signal filtering in both TS modes', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(workspace, { recursive: true });
    const base = { workspace, profile: 'p', outputPath: '/out', currentTimestamp: 'now', intelligence: 'fake', snapshot: createContextSnapshot(workspace) };
    const prompts = [buildGranolaPrompt({ ...base, context: { mode: 'mcp' } }), buildGranolaPrompt({ ...base, context: { mode: 'api' }, transcriptContent: 'transcript' })];
    const frozen = ['**SIGNAL — capture:**', '**NOISE — skip:**', 'Do NOT invent information', 'needs_input'];
    for (const phrase of frozen) for (const prompt of prompts) expect(prompt).toContain(phrase);
    expect(prompts[0]).toContain('DRAFT_SOURCE_UNAVAILABLE');
  });

  it('filters incomplete, old and empty API meetings', () => {
    const now = new Date('2026-01-02T12:00:00Z');
    const notes = filterApiMeetings({ notes: [
      { id: 'ok', title: 'Good', transcript: 'signal', created_at: '2026-01-02T11:00:00Z' },
      { id: 'partial', transcript: 'wait', created_at: '2026-01-02T11:45:00Z' },
      { id: 'old', transcript: 'old', created_at: '2025-12-31T00:00:00Z' },
      { id: 'empty', created_at: '2026-01-02T11:00:00Z' },
      { title: 'Missing receipt', transcript: 'signal', created_at: '2026-01-02T11:00:00Z' },
    ]}, '2026-01-01T00:00:00Z', now);
    expect(notes.map(n => n.id)).toEqual(['ok']);
    expect(formatApiMeetings(notes)).toContain('=== Good ===\nMeeting ID: ok');
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
        fetchApi: async token => { expect(token).toBe('secret'); return [{ id: 'meeting-1', title: 'Fallback', transcript: '', content: 'content body', created_at: '2026-01-02T11:00:00Z' }]; },
        async invoke(input) { prompt = input.prompt; files.set(input.outputPath, '---\noutcome: no_change\n---\n'); return 0; }, makeTemp: () => '/prompt',
        readFile: path => files.get(path)!, writeFile: (path, value) => { files.set(path, value); }, removeFile: path => { files.delete(path); }, exists: path => path === '/bg/intelligence/fake.sh' || files.has(path),
      }});
      expect(output).toContain('outcome: no_change');
      expect(prompt).toContain('content body');
      expect(prompt).toContain('Meeting ID: meeting-1');
      expect(prompt).toContain('meeting_ids:');
    } finally { if (previous === undefined) delete process.env.DRAFT_GRANOLA_INTELLIGENCE; else process.env.DRAFT_GRANOLA_INTELLIGENCE = previous; }
  });
});

describe('Granola state and orchestration', () => {
  it('round-trips malformed/default state and deduplicates meeting IDs', () => {
    const statePath = join(ROOT, 'state.json'); mkdirSync(ROOT, { recursive: true }); writeFileSync(statePath, 'bad');
    expect(readGranolaState(statePath)).toEqual({ last_checked_at: null, processed_meeting_ids: [] });
    expect(mergeGranolaState({ last_checked_at: null, processed_meeting_ids: ['a'] }, 'now', ['a', 'b']).processed_meeting_ids).toEqual(['a', 'b']);
  });

  it('applies rewrites, acknowledges validated meeting IDs, and rejects overlap', async () => {
    const statePath = join(ROOT, 'state.json'); const workspace = join(ROOT, 'workspace'); const writes = new Map<string, string>(); const logs: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const poll = createGranolaPoller({ statePath, workspace, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true,
      async synthesize() { await gate; return validUpdate('meet-1'); },
      write(path, content) { writes.set(path, content); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content, { flag: 'w' }); },
      route: () => ({ status: 'success', outcome: 'rewrite', flaggedPath: null, meetingIds: ['meet-1'] }),
      now: () => new Date('2026-01-02T12:00:00Z'), log: (_level, message) => { logs.push(message); },
    });
    mkdirSync(ROOT, { recursive: true }); const first = poll(); expect(await poll()).toBe('overlap'); release(); expect(await first).toBe('applied');
    expect([...writes.keys()]).toEqual([statePath]);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).processed_meeting_ids).toEqual(['meet-1']);
    expect(logs.some(message => message.startsWith('starting poll'))).toBe(true); expect(logs.some(message => message.startsWith('context updated'))).toBe(true); expect(logs.some(message => message.startsWith('state updated'))).toBe(true);
  });

  it('does not advance state when the handler fails', async () => {
    const statePath = join(ROOT, 'state.json'); const writes: string[] = [];
    const poll = createGranolaPoller({ statePath, workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true, synthesize: async () => validUpdate('meet-1'),
      route: () => { throw new Error('handler failed'); },
      write(path) { writes.push(path); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await expect(poll()).rejects.toThrow('handler failed'); expect(writes).toEqual([]);
  });

  it('advances state after a durable flagged outcome', async () => {
    const writes = new Map<string, string>(); const statePath = join(ROOT, 'flagged-state.json');
    const poll = createGranolaPoller({ statePath, workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true, synthesize: async () => validUpdate('meet-flagged'),
      route: () => ({ status: 'flagged', outcome: 'stale', flaggedPath: '/flagged.md', meetingIds: ['meet-flagged'] }),
      write: (path, content) => { writes.set(path, content); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(await poll()).toBe('flagged');
    expect(JSON.parse(writes.get(statePath)!)).toMatchObject({
      last_checked_at: '2026-01-01T00:00:00Z',
      processed_meeting_ids: ['meet-flagged'],
    });
  });

  it('advances state for explicit no_change with a meeting receipt list', async () => {
    const writes = new Map<string, string>(); const statePath = join(ROOT, crypto.randomUUID(), 'state.json');
    const poll = createGranolaPoller({ statePath, workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true, synthesize: async () => '---\noutcome: no_change\nmeeting_ids: []\n---\n', write: (path, content) => { writes.set(path, content); }, now: () => new Date('2026-02-01T00:00:00Z'),
      route: () => ({ status: 'success', outcome: 'no_change', flaggedPath: null, meetingIds: [] }),
    });
    expect(await poll()).toBe('empty'); expect(JSON.parse(writes.get(statePath)!).last_checked_at).toBe('2026-02-01T00:00:00Z');
  });

  it('does not advance state when empty output is rejected', async () => {
    const writes: string[] = [];
    const poll = createGranolaPoller({ statePath: join(ROOT, 'empty-state.json'), workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true, synthesize: async () => '', write: path => { writes.push(path); }, now: () => new Date('2026-02-01T00:00:00Z'),
      route: () => { throw new Error('invalid maintainer output'); },
    });
    await expect(poll()).rejects.toThrow('invalid maintainer output');
    expect(writes).toEqual([]);
  });

  it('does not advance state when synthesis output is invalid', async () => {
    const writes: string[] = [];
    const poll = createGranolaPoller({ statePath: join(ROOT, 'state.json'), workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true, synthesize: async () => 'not frontmatter', write: path => { writes.push(path); }, now: () => new Date('2026-01-01T00:00:00Z'),
      route: () => { throw new Error('invalid maintainer output'); },
    });
    await expect(poll()).rejects.toThrow('invalid maintainer output');
    expect(writes).toEqual([]);
  });

  it('keeps source unavailability outside maintainer routing and preserves the watermark', async () => {
    const statePath = join(ROOT, 'source-unavailable.json');
    const before = { last_checked_at: '2026-01-01T00:00:00Z', processed_meeting_ids: ['old'] };
    mkdirSync(ROOT, { recursive: true }); writeFileSync(statePath, JSON.stringify(before));
    let routeCalled = false;
    const poll = createGranolaPoller({ statePath, workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true,
      synthesize: async () => 'DRAFT_SOURCE_UNAVAILABLE {"code":"mcp_tool_error","message":"tool call failed"}',
      route: () => { routeCalled = true; throw new Error('should not route'); },
      write: (path, content) => writeFileSync(path, content),
      now: () => new Date('2026-01-02T00:00:00Z'),
    });
    await expect(poll()).rejects.toMatchObject({ name: 'SourceUnavailableError', code: 'mcp_tool_error' });
    expect(routeCalled).toBe(false);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
      ...before,
      health: { status: 'unavailable', code: 'mcp_tool_error' },
    });
  });

  it('defers and leaves state byte-identical when the workspace is locked', async () => {
    const statePath = join(ROOT, 'locked-state.json'); mkdirSync(ROOT, { recursive: true });
    const before = JSON.stringify({ last_checked_at: '2025-12-31T00:00:00Z', processed_meeting_ids: ['old'] });
    writeFileSync(statePath, before);
    const writes: string[] = [];
    const poll = createGranolaPoller({ statePath, workspace: ROOT, profile: 'p', mode: 'mcp' }, {
      verifyMcp: async () => true, synthesize: async () => validUpdate('meet-locked'),
      route: () => ({ status: 'locked', outcome: 'rewrite', flaggedPath: null, meetingIds: [] }),
      write: path => { writes.push(path); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(await poll()).toBe('deferred');
    expect(writes).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('rejects an invalid poller mode before any external work', async () => {
    let called = false;
    const poll = createGranolaPoller({ statePath: '/state', workspace: ROOT, profile: 'p', mode: 'bad' as never }, {
      verifyMcp: async () => { called = true; return true; }, synthesize: async () => { called = true; return ''; }, write: () => { called = true; }, now: () => new Date(),
    });
    await expect(poll()).rejects.toThrow('unknown Granola mode'); expect(called).toBe(false);
  });
});

function validUpdate(id: string): string { return `---
outcome: rewrite
meeting_ids:
  - ${id}
rewrites:
  - file: context/product/index.md
    base_sha256: ${"a".repeat(64)}
    summary: A specific product decision.
    content: |
      # Product
      A specific product decision.
---`; }
