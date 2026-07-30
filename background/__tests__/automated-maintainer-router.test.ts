import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { routeAutomatedMaintainerOutput } from '../automated-maintainer-router';

const ROOT = `/tmp/draft-automated-maintainer-router-${process.pid}`;
const metadata = {
  job_id: 'job-1',
  input_source: 'slack',
  synthesized_by: 'test-maintainer',
  timestamp: '2026-07-29T12:00:00Z',
  profile: 'test',
} as const;

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('automated maintainer router', () => {
  it('accepts explicit no_change and rejects accidental empty output', () => {
    mkdirSync(ROOT, { recursive: true });
    expect(() => routeAutomatedMaintainerOutput('', metadata, ROOT))
      .toThrow('invalid maintainer output');
    expect(routeAutomatedMaintainerOutput('---\noutcome: no_change\n---\n', metadata, ROOT)).toEqual({
      status: 'success', outcome: 'no_change', flaggedPath: null, meetingIds: [],
    });
    expect(routeAutomatedMaintainerOutput(
      '---\noutcome: no_change\nmeeting_ids:\n  - meeting-1\n  - meeting-2\n---\n',
      metadata,
      ROOT,
    ).meetingIds).toEqual(['meeting-1', 'meeting-2']);
  });

  it('requires explicit receipt lists for meeting sources', () => {
    mkdirSync(ROOT, { recursive: true });
    for (const inputSource of ['granola', 'fireflies'] as const) {
      expect(() => routeAutomatedMaintainerOutput(
        '---\noutcome: no_change\n---\n',
        { ...metadata, input_source: inputSource },
        ROOT,
      )).toThrow(`${inputSource} maintainer output must include meeting_ids`);
    }
  });

  it('automatically applies validated rewrites', () => {
    const target = join(ROOT, 'context', 'product', 'index.md');
    const before = 'old product context\n';
    mkdirSync(join(ROOT, 'context', 'product'), { recursive: true });
    writeFileSync(target, before);
    const hash = createHash('sha256').update(before).digest('hex');
    const output = `---
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${hash}
    summary: Refresh product direction
    content: |
      new product context
---
`;

    const result = routeAutomatedMaintainerOutput(output, metadata, ROOT);
    expect(result.status).toBe('success');
    expect(result.outcome).toBe('rewrite');
    expect(readFileSync(target, 'utf8')).toBe('new product context\n');
  });

  it('durably flags needs_input and returns locked (not a throw) while a live owner holds the lock', () => {
    mkdirSync(ROOT, { recursive: true });
    const flagged = routeAutomatedMaintainerOutput(
      '---\noutcome: needs_input\nneeds_input_reason: Conflicting durable decisions\n---\n',
      metadata,
      ROOT,
    );
    expect(flagged.status).toBe('flagged');
    expect(flagged.outcome).toBe('needs_input');
    expect(flagged.flaggedPath).not.toBeNull();

    const target = join(ROOT, 'context', 'product', 'index.md');
    const before = 'current\n';
    mkdirSync(join(ROOT, 'context', 'product'), { recursive: true });
    writeFileSync(target, before);
    const lockDir = join(ROOT, '.automated-maintainer.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner'), JSON.stringify({
      token: 'other', pid: process.pid, acquired_at: new Date().toISOString(),
    }));
    const hash = createHash('sha256').update(before).digest('hex');
    const result = routeAutomatedMaintainerOutput(`---
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${hash}
    summary: Locked rewrite
    content: |
      next
---
`, metadata, ROOT);
    expect(result.status).toBe('locked');
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('rejects invalid output before invoking the handler', () => {
    mkdirSync(ROOT, { recursive: true });
    expect(() => routeAutomatedMaintainerOutput('not frontmatter', metadata, ROOT))
      .toThrow('invalid maintainer output: missing YAML frontmatter');
  });
});
