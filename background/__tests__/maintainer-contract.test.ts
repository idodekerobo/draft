import { describe, expect, it } from 'bun:test';
import {
  buildMaintainerContractPrompt,
  type MaintainerContractInput,
} from '../synthesizers/maintainer-contract';
import type { ContextSnapshot } from '../synthesizers/synthesis-runtime';

const metadata: MaintainerContractInput['metadata'] = {
  session_id: 'session-123',
  input_source: 'source-neutral',
  synthesized_by: 'maintainer-v1',
  timestamp: '2026-07-29T12:00:00Z',
  profile: 'default',
};

const snapshot: ContextSnapshot = {
  snapshotPath: '/tmp/draft-context-snapshot-fixed',
  files: [
    {
      relativePath: 'context/priorities/index.md',
      snapshotPath: '/tmp/draft-context-snapshot-fixed/context/priorities/index.md',
      sha256: 'a'.repeat(64),
    },
    {
      relativePath: 'context/product/index.md',
      snapshotPath: '/tmp/draft-context-snapshot-fixed/context/product/index.md',
      sha256: 'b'.repeat(64),
    },
  ],
  tensions: {
    relativePath: 'context/tensions.md',
    snapshotPath: '/tmp/draft-context-snapshot-fixed/context/tensions.md',
    sha256: 'c'.repeat(64),
  },
};

function prompt(value: ContextSnapshot = snapshot): string {
  return buildMaintainerContractPrompt({
    snapshot: value,
    metadata,
    outputPath: '/tmp/maintainer-output.md',
  });
}

describe('buildMaintainerContractPrompt', () => {
  it('renders every stable snapshot path and host hash plus trusted output details', () => {
    const result = prompt();

    for (const file of [...snapshot.files, snapshot.tensions!]) {
      expect(result).toContain(file.relativePath);
      expect(result).toContain(file.snapshotPath);
      expect(result).toContain(file.sha256);
    }
    for (const value of Object.values(metadata)) expect(result).toContain(value);
    expect(result).toContain('/tmp/maintainer-output.md');
  });

  it('treats the optional tensions snapshot as read-only and handles its absence', () => {
    expect(prompt()).toContain('context/tensions.md (optional conflict evidence; read-only)');
    expect(prompt()).toContain('Never write to a snapshot path or to context/tensions.md');
    expect(prompt({ ...snapshot, tensions: null })).toContain('(no tensions snapshot supplied)');
  });

  it('shows all three outcome examples with one canonical delimited frontmatter block', () => {
    const result = prompt();
    const delimiters = result.match(/^---$/gm) ?? [];
    const opening = result.indexOf('\n---\n');
    const closing = result.indexOf('\n---\n', opening + 5);

    expect(delimiters).toHaveLength(2);
    expect(opening).toBeGreaterThan(-1);
    expect(closing).toBeGreaterThan(opening);
    expect(result.indexOf('rewrites:', opening)).toBeLessThan(closing);
    expect(result.slice(opening, closing)).toContain('session_id: "session-123"');
    expect(result.slice(closing + 5)).not.toContain('\n---\n');
    expect(result).toContain('needs_input_reason when applicable, before its closing ---');
    expect(result).toContain('replace rewrites with needs_input_reason:');
    expect(result).toContain('Worked no_change example');
    expect(result).toContain('Worked needs_input example');
    expect(result).toContain('Canonical rewrite example');
    expect(result).toContain('self-hosted only');
    expect(result).toContain('hosted is the default');
  });

  it('includes all required M0 maintainer findings', () => {
    const result = prompt();

    for (const finding of [
      'no_change, rewrite, or needs_input',
      'unique existing context/<dimension>/index.md target',
      'supplied host_sha256 exactly into base_sha256',
      'summary and content must both be nonempty',
      'removals is optional',
      'Use needs_input only for a named conflict',
      'A later timestamp is not a resolution receipt',
      'Preserve all still-valid context',
      'do not restate a PR, diff, transcript, or activity feed',
      'existing "Known Patterns"',
      'all transport layers use isolated temporary clones',
      'PR #42 changed publish.ts and added tests',
      'attributable decision, owner, or constraint',
      'Emit no writes for tensions',
    ]) {
      expect(result).toContain(finding);
    }
  });
});
