import { afterEach, describe, expect, it, mock } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

// verifyGranolaMcp must resolve `claude` via resolveRunnerBin (existsSync against
// known install paths, like the gh/codex pollers) rather than a bare
// Bun.spawn(['claude', ...]) that depends on the daemon process's own PATH.
// The daemon's LaunchAgent PATH is baked once at install.sh time from
// `command -v claude`; a bare spawn throws "Executable not found in $PATH" —
// uncaught, so it crashes the whole poll — whenever Claude Code was installed
// after Draft's daemon, or lives somewhere install.sh didn't scan.
let mockResolveRunnerBin: (name: string) => Promise<string | null> = async () => null;
mock.module('draft-core/agents/headless', () => ({ resolveRunnerBin: (name: string) => mockResolveRunnerBin(name) }));

const { verifyGranolaMcp } = await import('../integrations/granola/granola-poller');

const ROOT = `/tmp/draft-granola-verify-mcp-test-${process.pid}`;
afterEach(() => { rmSync(ROOT, { recursive: true, force: true }); mockResolveRunnerBin = async () => null; });

describe('verifyGranolaMcp', () => {
  it('resolves false (never throws) when claude cannot be resolved on PATH', async () => {
    let resolveCalledWith: string | undefined;
    mockResolveRunnerBin = async name => { resolveCalledWith = name; return null; };
    await expect(verifyGranolaMcp()).resolves.toBe(false);
    expect(resolveCalledWith).toBe('claude');
  });

  it('spawns the resolved binary path (not a bare "claude") and detects granola in mcp list', async () => {
    mkdirSync(ROOT, { recursive: true });
    const fakeClaude = join(ROOT, 'fake-claude');
    writeFileSync(fakeClaude, '#!/bin/bash\necho "granola-mcp-server  connected"\nexit 0\n');
    chmodSync(fakeClaude, 0o755);
    mockResolveRunnerBin = async name => name === 'claude' ? fakeClaude : null;
    await expect(verifyGranolaMcp()).resolves.toBe(true);
  });

  it('resolves false when the resolved claude has no granola MCP registered', async () => {
    mkdirSync(ROOT, { recursive: true });
    const fakeClaude = join(ROOT, 'fake-claude-no-granola');
    writeFileSync(fakeClaude, '#!/bin/bash\necho "some-other-mcp  connected"\nexit 0\n');
    chmodSync(fakeClaude, 0o755);
    mockResolveRunnerBin = async () => fakeClaude;
    await expect(verifyGranolaMcp()).resolves.toBe(false);
  });
});
