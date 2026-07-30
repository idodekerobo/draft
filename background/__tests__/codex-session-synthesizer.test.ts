import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  buildCodexSessionPrompt,
  parseCodexConversation,
  runCodexSession,
} from '../synthesizers/codex-session';
import { createContextSnapshot, type IntelligenceDeps } from '../synthesizers/synthesis-runtime';

const ROOT = `/tmp/draft-codex-session-test-${process.pid}`;
afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

function setup() {
  const workspace = join(ROOT, 'workspace');
  mkdirSync(join(workspace, 'context', 'product'), { recursive: true });
  writeFileSync(join(workspace, 'context', 'product', 'index.md'), 'product');
  const transcript = join(ROOT, 'session.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Ship the durable decision' } }),
    JSON.stringify({ type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Decision recorded' }] } }),
  ].join('\n'));
  return { workspace, transcript };
}

describe('Codex session synthesizer', () => {
  it('exports a direct prompt builder using snapshot hashes and the shared outcomes', () => {
    const { workspace } = setup();
    const snapshot = createContextSnapshot(workspace);
    const prompt = buildCodexSessionPrompt({
      job: { session_id: 'codex-1', cwd: '/repo' },
      profile: 'p',
      outputPath: '/out',
      currentTimestamp: '2026-01-01T00:00:00Z',
      intelligence: 'fake',
      conversationText: 'User: decide',
      snapshot,
    });
    expect(prompt).toContain(snapshot.files[0].snapshotPath);
    expect(prompt).toContain(snapshot.files[0].sha256);
    expect(prompt).toContain('outcome: rewrite');
    expect(prompt).toContain('base_sha256:');
    expect(prompt).not.toContain('context_updates');
  });

  it('parses user and assistant conversation evidence', () => {
    expect(parseCodexConversation([
      '{"type":"event_msg","payload":{"type":"user_message","message":"hello"}}',
      'invalid',
      '{"type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"world"}]}}',
    ].join('\n'))).toBe('User: hello\n\nAssistant: world');
  });

  it('runs through the shared intelligence boundary', async () => {
    const { workspace, transcript } = setup();
    const files = new Map<string, string>([['/bg/intelligence/fake.sh', 'stub']]);
    let prompt = '';
    const deps: IntelligenceDeps = {
      async invoke(input) { prompt = input.prompt; files.set(input.outputPath, '---\noutcome: no_change\n---\n'); return 0; },
      makeTemp: () => '/prompt',
      readFile: path => files.get(path)!,
      writeFile: (path, value) => { files.set(path, value); },
      removeFile: path => { files.delete(path); },
      exists: path => files.has(path),
    };
    const previous = process.env.DRAFT_SESSION_INTELLIGENCE;
    process.env.DRAFT_SESSION_INTELLIGENCE = 'fake';
    try {
      expect(await runCodexSession({ session_id: 'id', transcript_path: transcript, profile: 'p' }, { workspace, backgroundDir: '/bg', deps })).toContain('outcome: no_change');
      expect(prompt).toContain('Ship the durable decision');
    } finally {
      if (previous === undefined) delete process.env.DRAFT_SESSION_INTELLIGENCE;
      else process.env.DRAFT_SESSION_INTELLIGENCE = previous;
    }
  });
});
