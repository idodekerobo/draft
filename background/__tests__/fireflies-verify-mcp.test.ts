import { afterEach, describe, expect, it, mock } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// verifyFirefliesMcp must resolve `claude` via resolveRunnerBin (existsSync against
// known install paths, like the gh/codex pollers) rather than a bare
// Bun.spawn(['claude', ...]) that depends on the daemon process's own PATH.
let mockResolveRunnerBin: (name: string) => Promise<string | null> = async () => null;
mock.module('draft-core/agents/headless', () => ({ resolveRunnerBin: (name: string) => mockResolveRunnerBin(name) }));

const { verifyFirefliesMcp } = await import('../integrations/fireflies/fireflies-poller');

const ROOT = `/tmp/draft-fireflies-verify-mcp-test-${process.pid}`;
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); mockResolveRunnerBin = async () => null; });

describe('verifyFirefliesMcp', () => {
  it('resolves false (never throws) when claude cannot be resolved on PATH', async () => {
    let resolveCalledWith: string | undefined;
    mockResolveRunnerBin = async name => { resolveCalledWith = name; return null; };
    await expect(verifyFirefliesMcp()).resolves.toBe(false);
    expect(resolveCalledWith).toBe('claude');
  });

  it('spawns the resolved binary path (not a bare "claude") and detects fireflies in mcp list', async () => {
    mkdirSync(ROOT, { recursive: true });
    const fakeClaude = join(ROOT, 'fake-claude');
    writeFileSync(fakeClaude, '#!/bin/bash\necho "fireflies  connected"\nexit 0\n');
    chmodSync(fakeClaude, 0o755);
    mockResolveRunnerBin = async name => name === 'claude' ? fakeClaude : null;
    await expect(verifyFirefliesMcp()).resolves.toBe(true);
  });

  it('resolves false when the resolved claude has no fireflies MCP registered', async () => {
    mkdirSync(ROOT, { recursive: true });
    const fakeClaude = join(ROOT, 'fake-claude-no-fireflies');
    writeFileSync(fakeClaude, '#!/bin/bash\necho "some-other-mcp  connected"\nexit 0\n');
    chmodSync(fakeClaude, 0o755);
    mockResolveRunnerBin = async () => fakeClaude;
    await expect(verifyFirefliesMcp()).resolves.toBe(false);
  });
});
