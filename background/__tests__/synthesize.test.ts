import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { synthesize } from '../synthesize';

const ROOT = `/tmp/draft-synthesize-router-${process.pid}`;
let testNumber = 0;
const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createRun(output: string, jobOverrides: Record<string, unknown> = {}): {
  workspace: string;
  run: () => ReturnType<typeof synthesize>;
} {
  const root = join(ROOT, String(++testNumber));
  const workspace = join(root, 'workspace');
  const jobPath = join(root, 'job-router-test.json');
  createdRoots.push(root);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(jobPath, JSON.stringify({
    job_id: `router-test-${testNumber}`,
    profile: 'router-test',
    source: 'github',
    reason: 'poll',
    ...jobOverrides,
  }));
  return {
    workspace,
    run: () => synthesize(jobPath, {
      getWorkspacePath: () => workspace,
      executeAdapter: async () => ({ exitCode: 0, stdoutText: output }),
    }),
  };
}

function rewriteOutput(before: string, content = 'new product context\n'): string {
  const hash = createHash('sha256').update(before).digest('hex');
  return `---
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: ${hash}
    summary: Refresh product direction
    content: |
      ${content.trimEnd()}
---
`;
}

describe('synthesize automated maintainer routing', () => {
  it('records no_change as success with zero proposals', async () => {
    const testRun = createRun('---\noutcome: no_change\n---\n');

    expect(await testRun.run()).toEqual({ status: 'success', proposalsGenerated: 0 });
  });

  it('applies rewrites automatically and records zero proposals', async () => {
    const before = 'old product context\n';
    const testRun = createRun(rewriteOutput(before));
    const target = join(testRun.workspace, 'context', 'product', 'index.md');
    mkdirSync(join(testRun.workspace, 'context', 'product'), { recursive: true });
    writeFileSync(target, before);

    expect(await testRun.run()).toEqual({ status: 'success', proposalsGenerated: 0 });
    expect(readFileSync(target, 'utf8')).toBe('new product context\n');
  });

  it('stages needs_input for review and counts one generated proposal', async () => {
    const testRun = createRun(
      '---\noutcome: needs_input\nneeds_input_reason: Product sources conflict\n---\n',
    );

    expect(await testRun.run()).toEqual({ status: 'success', proposalsGenerated: 1 });
    const flaggedDir = join(testRun.workspace, 'proposals', 'flagged');
    expect(existsSync(flaggedDir)).toBe(true);
    expect(readdirSync(flaggedDir).filter(name => name.endsWith('.md'))).toHaveLength(1);
  });

  it('records invalid output as failed without a success checkpoint', async () => {
    const testRun = createRun('not maintainer frontmatter');

    const result = await testRun.run();
    expect(result.status).toBe('failed');
    expect(result.proposalsGenerated).toBe(0);
    expect(result.errorMsg).toContain('invalid maintainer output');
  });

  it('records empty adapter output as a success no-op, not a contract violation', async () => {
    const testRun = createRun('');

    expect(await testRun.run()).toEqual({ status: 'success', proposalsGenerated: 0 });
  });

  it('records stale rewrite output as needs_input', async () => {
    const testRun = createRun(rewriteOutput('stale product context\n'));
    const target = join(testRun.workspace, 'context', 'product', 'index.md');
    mkdirSync(join(testRun.workspace, 'context', 'product'), { recursive: true });
    writeFileSync(target, 'current product context\n');

    expect(await testRun.run()).toEqual({ status: 'success', proposalsGenerated: 1 });
  });

  it('rejects unsafe or unbounded trusted metadata before resolving a workspace', async () => {
    for (const [jobOverrides, errorMsg] of [
      [{ profile: '../outside' }, 'invalid job profile'],
      [{ job_id: 'x'.repeat(256) }, 'invalid job_id'],
      [{ session_id: 42 }, 'invalid session_id'],
      [{ timestamp: 'not-a-timestamp' }, 'invalid job timestamp'],
    ] as const) {
      const testRun = createRun('---\noutcome: no_change\n---\n', jobOverrides);
      expect(await testRun.run()).toEqual({
        status: 'failed',
        proposalsGenerated: 0,
        errorMsg,
      });
    }
  });

  it('defers when the workspace is locked by a live owner', async () => {
    const before = 'current product context\n';
    const testRun = createRun(rewriteOutput(before, 'next product context\n'));
    const target = join(testRun.workspace, 'context', 'product', 'index.md');
    mkdirSync(join(testRun.workspace, 'context', 'product'), { recursive: true });
    writeFileSync(target, before);
    const lockDir = join(testRun.workspace, '.automated-maintainer.lock');
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'owner'), JSON.stringify({
      token: 'other', pid: process.pid, acquired_at: new Date().toISOString(),
    }));

    const result = await testRun.run();
    expect(result).toEqual({ status: 'deferred', proposalsGenerated: 0 });
    expect(readFileSync(target, 'utf8')).toBe(before);
  });
});
