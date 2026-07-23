import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { buildClaudeSessionPrompt, runClaudeSession } from '../synthesizers/claude-code-session';
import type { IntelligenceDeps } from '../synthesizers/synthesis-runtime';

const ROOT = `/tmp/draft-claude-session-test-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function setup() {
  const workspace = join(ROOT, 'workspace');
  mkdirSync(join(workspace, 'context', 'product'), { recursive: true });
  writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'product');
  const transcript = join(ROOT, 'session.jsonl'); writeFileSync(transcript, '{}\n');
  return { workspace, transcript };
}

describe('Claude session TS parity', () => {
  it('matches the full normalized legacy prompt golden', () => {
    const workspace = join(ROOT, 'workspace');
    const transcript = join(ROOT, 'session.jsonl');
    mkdirSync(join(workspace, 'context', 'product'), { recursive: true });
    writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'product');
    writeFileSync(transcript, '{}\n');
    const job = { session_id: 'abcdefghijk', transcript_path: transcript, timestamp: '2026-01-01T00:00:00Z', profile: 'p' };
    const tsPrompt = buildClaudeSessionPrompt({ job, workspace, profile: 'p', outputPath: '/GENERATED_OUTPUT', currentTimestamp: '2099-01-01T00:00:00Z' });
    const normalize = (value: string) => value
      .replace(/^timestamp: .*$/gm, 'timestamp: <TIMESTAMP>')
      .replaceAll(workspace, '<WORKSPACE>')
      .replaceAll(transcript, '<TRANSCRIPT>')
      .replaceAll('/GENERATED_OUTPUT', '<OUTPUT>');
    const digest = createHash('sha256').update(normalize(tsPrompt)).digest('hex');
    // Captured after the old shell and TS prompts passed a full normalized diff.
    expect(digest).toBe('bda70caaf48368cb9ffa25140f6a4e8a7ba86fab031422684504e69af791c352');
  });

  it('keeps path-based transcript handling and immutable append/tension rules', () => {
    const { workspace, transcript } = setup();
    const prompt = buildClaudeSessionPrompt({ job: { session_id: 'abcdefghijk', transcript_path: transcript, timestamp: '2026-01-01T00:00:00Z' }, workspace, profile: 'p', outputPath: '/out', currentTimestamp: '2026-01-02T00:00:00Z' });
    expect(prompt).toContain(`Session transcript (full): ${transcript}`);
    expect(prompt).not.toContain('{}');
    expect(prompt).toContain('action: tension');
    expect(prompt).toContain('"overwrite" — do NOT use in synthesis');
    expect(prompt).toContain(join(workspace, 'context', 'product', 'index.md'));
  });

  it('runs through a fully faked intelligence adapter and validates errors', async () => {
    const { workspace, transcript } = setup();
    let captured = '';
    const files = new Map<string, string>([['/bg/intelligence/claude-code.sh', 'stub']]);
    const deps: IntelligenceDeps = {
      async invoke(input) { captured = input.prompt; files.set(input.outputPath, '---\ncontext_updates: []\n---\n'); return 0; },
      makeTemp: () => '/prompt', readFile: path => files.get(path)!, writeFile: (path, value) => { files.set(path, value); }, removeFile: path => { files.delete(path); }, exists: path => files.has(path),
    };
    expect(await runClaudeSession({ session_id: 'id', transcript_path: transcript, profile: 'p' }, { workspace, backgroundDir: '/bg', deps })).toStartWith('---');
    expect(captured).toContain(transcript);
    await expect(runClaudeSession({ transcript_path: join(ROOT, 'missing') }, { workspace, deps })).rejects.toThrow('transcript not found');
  });
});
