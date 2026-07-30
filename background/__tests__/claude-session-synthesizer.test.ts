import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { buildClaudeSessionPrompt, runClaudeSession } from '../synthesizers/claude-code-session';
import { createContextSnapshot, type IntelligenceDeps } from '../synthesizers/synthesis-runtime';

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
  it('renders the shared rewrite contract against a host-created snapshot', () => {
    const workspace = join(ROOT, 'workspace');
    const transcript = join(ROOT, 'session.jsonl');
    mkdirSync(join(workspace, 'context', 'product'), { recursive: true });
    writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'product');
    writeFileSync(transcript, '{}\n');
    const job = { session_id: 'abcdefghijk', transcript_path: transcript, timestamp: '2026-01-01T00:00:00Z', profile: 'p' };
    const snapshot = createContextSnapshot(workspace);
    const prompt = buildClaudeSessionPrompt({ job, workspace, profile: 'p', outputPath: '/GENERATED_OUTPUT', currentTimestamp: '2099-01-01T00:00:00Z', intelligence: 'fake', snapshot });
    expect(prompt).toContain(snapshot.files[0].snapshotPath);
    expect(prompt).toContain(`host_sha256: ${snapshot.files[0].sha256}`);
    expect(prompt).toContain('outcome: rewrite');
    expect(prompt).toContain('base_sha256:');
    expect(prompt).not.toContain('context_updates');
  });

  it('keeps path-based transcript handling and immutable append/tension rules', () => {
    const { workspace, transcript } = setup();
    const snapshot = createContextSnapshot(workspace);
    const prompt = buildClaudeSessionPrompt({ job: { session_id: 'abcdefghijk', transcript_path: transcript, timestamp: '2026-01-01T00:00:00Z' }, workspace, profile: 'p', outputPath: '/out', currentTimestamp: '2026-01-02T00:00:00Z', intelligence: 'fake', snapshot });
    expect(prompt).toContain(`Session transcript (full): ${transcript}`);
    expect(prompt).not.toContain('{}');
    expect(prompt).toContain('needs_input');
    expect(prompt).toContain(snapshot.files[0].snapshotPath);
  });

  it('runs through a fully faked intelligence adapter and validates errors', async () => {
    const { workspace, transcript } = setup();
    let captured = '';
    const files = new Map<string, string>([['/bg/intelligence/claude-code.sh', 'stub']]);
    const deps: IntelligenceDeps = {
      async invoke(input) { captured = input.prompt; files.set(input.outputPath, '---\noutcome: no_change\n---\n'); return 0; },
      makeTemp: () => '/prompt', readFile: path => files.get(path)!, writeFile: (path, value) => { files.set(path, value); }, removeFile: path => { files.delete(path); }, exists: path => files.has(path),
    };
    expect(await runClaudeSession({ session_id: 'id', transcript_path: transcript, profile: 'p' }, { workspace, backgroundDir: '/bg', deps })).toStartWith('---');
    expect(captured).toContain(transcript);
    await expect(runClaudeSession({ transcript_path: join(ROOT, 'missing') }, { workspace, deps })).rejects.toThrow('transcript not found');
  });
});
