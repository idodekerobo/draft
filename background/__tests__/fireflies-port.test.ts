import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { buildFirefliesPrompt, runFirefliesSynthesis } from '../synthesizers/fireflies';
import { createContextSnapshot } from '../synthesizers/synthesis-runtime';
import { createFirefliesPoller, mergeFirefliesState, readFirefliesState } from '../integrations/fireflies/fireflies-poller';

const ROOT = `/tmp/draft-fireflies-port-test-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('Fireflies prompt', () => {
  it('builds a single-mode MCP prompt with the fireflies tool table and processed-id skip list', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'context', 'product'), { recursive: true }); writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'x');
    const snapshot = createContextSnapshot(workspace);
    const prompt = buildFirefliesPrompt({ workspace, profile: 'p', outputPath: '/out', currentTimestamp: '2026-01-01T00:00:00Z', intelligence: 'fake', context: { processed_meeting_ids: ['done'] }, snapshot });
    expect(prompt).toContain('`fireflies_get_transcripts`');
    expect(prompt).toContain('`fireflies_get_transcript`');
    expect(prompt).toContain('`fireflies_get_summary`');
    expect(prompt).toContain('  - done');
    expect(prompt).toContain('meeting_ids:');
    expect(prompt).toContain(snapshot.files[0].snapshotPath);
    expect(prompt).toContain(snapshot.files[0].sha256);
    expect(prompt).toContain('outcome: rewrite');
    expect(prompt).toContain('base_sha256:');
    expect(prompt).not.toContain('context_updates');
  });

  it('keeps the shared SIGNAL/NOISE/contradiction contract phrases', () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(workspace, { recursive: true });
    const prompt = buildFirefliesPrompt({ workspace, profile: 'p', outputPath: '/out', currentTimestamp: 'now', intelligence: 'fake', context: {}, snapshot: createContextSnapshot(workspace) });
    const frozen = ['**SIGNAL — capture:**', '**NOISE — skip:**', 'Do NOT invent information', 'needs_input'];
    for (const phrase of frozen) expect(prompt).toContain(phrase);
    expect(prompt).toContain('DRAFT_SOURCE_UNAVAILABLE');
  });

  it('runs synthesis with fully faked intelligence boundaries', async () => {
    const workspace = join(ROOT, 'workspace'); mkdirSync(join(workspace, 'config'), { recursive: true });
    const files = new Map<string, string>(); let prompt = ''; const previous = process.env.DRAFT_FIREFLIES_INTELLIGENCE; process.env.DRAFT_FIREFLIES_INTELLIGENCE = 'fake';
    try {
      const output = await runFirefliesSynthesis({ profile: 'p', last_checked_at: null }, { workspace, backgroundDir: '/bg', now: new Date('2026-01-02T12:00:00Z'), deps: {
        async invoke(input) { prompt = input.prompt; files.set(input.outputPath, '---\noutcome: no_change\nmeeting_ids: []\n---\n'); return 0; }, makeTemp: () => '/prompt',
        readFile: path => files.get(path)!, writeFile: (path, value) => { files.set(path, value); }, removeFile: path => { files.delete(path); }, exists: path => path === '/bg/intelligence/fake.sh' || files.has(path),
      }});
      expect(output).toContain('outcome: no_change');
      expect(prompt).toContain('fireflies_get_transcripts');
    } finally { if (previous === undefined) delete process.env.DRAFT_FIREFLIES_INTELLIGENCE; else process.env.DRAFT_FIREFLIES_INTELLIGENCE = previous; }
  });
});

describe('Fireflies state and orchestration', () => {
  it('round-trips malformed/default state and deduplicates meeting IDs', () => {
    const statePath = join(ROOT, 'state.json'); mkdirSync(ROOT, { recursive: true }); writeFileSync(statePath, 'bad');
    expect(readFirefliesState(statePath)).toEqual({ last_checked_at: null, processed_meeting_ids: [] });
    expect(mergeFirefliesState({ last_checked_at: null, processed_meeting_ids: ['a'] }, 'now', ['a', 'b']).processed_meeting_ids).toEqual(['a', 'b']);
  });

  it('skips the poll when the api token is missing', async () => {
    let called = false;
    const poll = createFirefliesPoller({ statePath: join(ROOT, 'state.json'), workspace: ROOT, profile: 'p' }, {
      verifyMcp: async () => { called = true; return true; }, synthesize: async () => { called = true; return ''; }, write: () => { called = true; }, now: () => new Date(),
    });
    expect(await poll()).toBe('skipped');
    expect(called).toBe(false);
  });

  it('records the first unavailable MCP transition without advancing the watermark', async () => {
    const statePath = join(ROOT, 'state.json');
    let written = '';
    const poll = createFirefliesPoller({ statePath, workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => false, synthesize: async () => { throw new Error('should not be called'); },
      write: (_path, content) => { written = content; }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await expect(poll()).rejects.toMatchObject({ name: 'SourceUnavailableError', code: 'mcp_missing' });
    expect(JSON.parse(written)).toMatchObject({
      last_checked_at: null,
      health: { status: 'unavailable', code: 'mcp_missing' },
    });
  });

  it('applies rewrites, acknowledges validated meeting IDs, and rejects overlap', async () => {
    const statePath = join(ROOT, 'state.json'); const workspace = join(ROOT, 'workspace'); const writes = new Map<string, string>(); const logs: string[] = [];
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const poll = createFirefliesPoller({ statePath, workspace, profile: 'p', token: 'secret' }, {
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

  it('advances state for explicit no_change with a meeting receipt list', async () => {
    const writes = new Map<string, string>(); const statePath = join(ROOT, crypto.randomUUID(), 'state.json');
    const poll = createFirefliesPoller({ statePath, workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true, synthesize: async () => '---\noutcome: no_change\nmeeting_ids: []\n---\n', write: (path, content) => { writes.set(path, content); }, now: () => new Date('2026-02-01T00:00:00Z'),
      route: () => ({ status: 'success', outcome: 'no_change', flaggedPath: null, meetingIds: [] }),
    });
    expect(await poll()).toBe('empty'); expect(JSON.parse(writes.get(statePath)!).last_checked_at).toBe('2026-02-01T00:00:00Z');
  });

  it('defers and leaves state byte-identical when the workspace is locked', async () => {
    const statePath = join(ROOT, 'locked-state.json'); mkdirSync(ROOT, { recursive: true });
    const before = JSON.stringify({ last_checked_at: '2025-12-31T00:00:00Z', processed_meeting_ids: ['old'] });
    writeFileSync(statePath, before);
    const writes: string[] = [];
    const poll = createFirefliesPoller({ statePath, workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true, synthesize: async () => validUpdate('meet-locked'),
      route: () => ({ status: 'locked', outcome: 'rewrite', flaggedPath: null, meetingIds: [] }),
      write: path => { writes.push(path); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(await poll()).toBe('deferred');
    expect(writes).toEqual([]);
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });

  it('does not advance state when empty output is rejected', async () => {
    const writes: string[] = [];
    const poll = createFirefliesPoller({ statePath: join(ROOT, 'empty-state.json'), workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true, synthesize: async () => '', write: path => { writes.push(path); }, now: () => new Date('2026-02-01T00:00:00Z'),
      route: () => { throw new Error('invalid maintainer output'); },
    });
    await expect(poll()).rejects.toThrow('invalid maintainer output');
    expect(writes).toEqual([]);
  });

  it('does not advance state when synthesis output is invalid', async () => {
    const writes: string[] = [];
    const poll = createFirefliesPoller({ statePath: join(ROOT, 'state.json'), workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true, synthesize: async () => 'not frontmatter', write: path => { writes.push(path); }, now: () => new Date('2026-01-01T00:00:00Z'),
      route: () => { throw new Error('invalid maintainer output'); },
    });
    await expect(poll()).rejects.toThrow('invalid maintainer output');
    expect(writes).toEqual([]);
  });

  it('does not advance state when the handler fails', async () => {
    const statePath = join(ROOT, 'state.json'); const writes: string[] = [];
    const poll = createFirefliesPoller({ statePath, workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true, synthesize: async () => validUpdate('meet-1'),
      route: () => { throw new Error('handler failed'); },
      write(path) { writes.push(path); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    await expect(poll()).rejects.toThrow('handler failed'); expect(writes).toEqual([]);
  });

  it('advances state after a durable flagged outcome', async () => {
    const writes = new Map<string, string>(); const statePath = join(ROOT, 'flagged-state.json');
    const poll = createFirefliesPoller({ statePath, workspace: ROOT, profile: 'p', token: 'secret' }, {
      verifyMcp: async () => true, synthesize: async () => validUpdate('meet-flagged'),
      route: () => ({ status: 'flagged', outcome: 'needs_input', flaggedPath: '/flagged.md', meetingIds: ['meet-flagged'] }),
      write: (path, content) => { writes.set(path, content); }, now: () => new Date('2026-01-01T00:00:00Z'),
    });
    expect(await poll()).toBe('flagged');
    expect(JSON.parse(writes.get(statePath)!)).toMatchObject({
      last_checked_at: '2026-01-01T00:00:00Z',
      processed_meeting_ids: ['meet-flagged'],
    });
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
