import { afterEach, describe, expect, it } from 'bun:test';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync,
  utimesSync, writeFileSync,
} from 'fs';
import { join } from 'path';
import { runCodexScan } from '../integrations/codex/codex-scanner';

const ROOT = `/tmp/draft-codex-scanner-test-${process.pid}`;

function sessionDir(home: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return join(home, '.codex', 'sessions', String(now.getFullYear()),
    pad(now.getMonth() + 1), pad(now.getDate()));
}

function writeTranscript(home: string, now: Date, sessionId: string): string {
  const dir = sessionDir(home, now);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${sessionId}.jsonl`);
  writeFileSync(path, JSON.stringify({
    type: 'session_meta',
    payload: { session_id: sessionId, cwd: '/tmp/project' },
  }) + '\n');
  return path;
}

async function scan(homeDir: string, backgroundDir: string, now: Date) {
  await runCodexScan({
    homeDir, backgroundDir, profile: 'test-profile', now, scanIntervalMs: 1_000,
  });
}

afterEach(() => rmSync(ROOT, { recursive: true, force: true }));

describe('Codex scanner stabilization', () => {
  it('queues only after an unchanged second scan and does not duplicate success', async () => {
    const now = new Date('2026-06-29T18:00:00');
    const home = join(ROOT, 'home');
    const background = join(ROOT, 'background');
    const id = 'stable-session';
    writeTranscript(home, now, id);
    const pending = join(background, 'pending', `codex-${id}.json`);

    await scan(home, background, now);
    expect(existsSync(pending)).toBe(false);
    await scan(home, background, new Date(now.getTime() + 1_000));
    expect(existsSync(pending)).toBe(true);
    expect(JSON.parse(readFileSync(pending, 'utf8')).transcript_fingerprint)
      .toMatch(/^\d+:\d+$/);

    rmSync(pending);
    await scan(home, background, new Date(now.getTime() + 2_000));
    await scan(home, background, new Date(now.getTime() + 3_000));
    expect(existsSync(pending)).toBe(false);
  });

  it('resets stabilization when a transcript changes', async () => {
    const now = new Date('2026-06-29T18:00:00');
    const home = join(ROOT, 'home');
    const background = join(ROOT, 'background');
    const id = 'changing-session';
    const transcript = writeTranscript(home, now, id);
    const pending = join(background, 'pending', `codex-${id}.json`);

    await scan(home, background, now);
    appendFileSync(transcript, '{"type":"event_msg","payload":{"type":"user_message"}}\n');
    const changedAt = new Date(now.getTime() + 1_000);
    utimesSync(transcript, changedAt, changedAt);
    await scan(home, background, changedAt);
    expect(existsSync(pending)).toBe(false);
    await scan(home, background, new Date(now.getTime() + 2_000));
    expect(existsSync(pending)).toBe(true);
  });
});

describe('Codex scanner retries', () => {
  it('backs off with unique attempt IDs and stops after three attempts', async () => {
    const now = new Date('2026-06-29T18:00:00');
    const home = join(ROOT, 'home');
    const background = join(ROOT, 'background');
    const id = 'retry-session';
    writeTranscript(home, now, id);
    const pending = join(background, 'pending', `codex-${id}.json`);
    const failed = join(background, 'failed', `codex-${id}.json`);

    await scan(home, background, now);
    await scan(home, background, new Date(now.getTime() + 1_000));
    const first = JSON.parse(readFileSync(pending, 'utf8'));
    renameSync(pending, failed);
    utimesSync(failed, now, now);

    await scan(home, background, new Date(now.getTime() + 2_000));
    const second = JSON.parse(readFileSync(pending, 'utf8'));
    expect(second.attempt).toBe(2);
    expect(second.job_id).not.toBe(first.job_id);

    renameSync(pending, failed);
    utimesSync(failed, now, now);
    await scan(home, background, new Date(now.getTime() + 4_000));
    expect(JSON.parse(readFileSync(pending, 'utf8')).attempt).toBe(3);

    renameSync(pending, failed);
    utimesSync(failed, now, now);
    await scan(home, background, new Date(now.getTime() + 20_000));
    expect(existsSync(pending)).toBe(false);
    expect(existsSync(failed)).toBe(true);
  });
});
