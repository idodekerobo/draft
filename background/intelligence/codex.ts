// background/intelligence/codex.ts — Codex intelligence adapter
//
// Runs a synthesis prompt through `codex exec` headlessly (stdin → stdout).
// No tmux needed — codex exec is a true CLI, unlike the Claude Code TUI.
//
// Contract (same as all intelligence adapters):
//   process.argv[2] = prompt file path
//   process.argv[3] = output file path
//   Exit 0 on success, 1 on failure

import { existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BACKGROUND_DIR } from 'draft-core/config';
import { resolveRunnerBin } from 'draft-core/agents/headless';

const promptPath = process.argv[2];
const outputPath = process.argv[3];

if (!promptPath || !outputPath) {
  console.error('Usage: bun run intelligence/codex.ts <prompt_file> <output_file>');
  process.exit(1);
}

if (!existsSync(promptPath)) {
  console.error(`[codex.ts] prompt file not found: ${promptPath}`);
  process.exit(1);
}

const runnerBin = await resolveRunnerBin('codex');
if (!runnerBin) {
  console.error('[codex.ts] codex CLI not found in known paths');
  process.exit(1);
}

const cliCmd = [
  runnerBin,
  'exec',
  '--skip-git-repo-check',
  '--dangerously-bypass-approvals-and-sandbox',
  '-',
];

const spawnedAt = Date.now();

let proc: ReturnType<typeof Bun.spawn>;
try {
  proc = Bun.spawn(cliCmd, {
    stdin: Bun.file(promptPath),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, DRAFT_SUPPRESS_SESSION_END_HOOK: '1' },
  });
} catch (err) {
  console.error(`[codex.ts] failed to spawn codex: ${err}`);
  process.exit(1);
}

// 280s — leaves a 20s buffer under synthesize.ts's 300s kill timer
const TIMEOUT_MS = 280_000;
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  proc.kill();
}, TIMEOUT_MS);

const [exitCode, stdout, stderr] = await Promise.all([
  proc.exited,
  new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
  new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
]);
clearTimeout(timer);

if (timedOut) {
  console.error('[codex.ts] timed out after 280s');
  process.exit(1);
}

if (exitCode !== 0) {
  console.error(`[codex.ts] codex exited ${exitCode}: ${stderr.slice(0, 500)}`);
  process.exit(1);
}

if (!stdout.trim()) {
  console.error('[codex.ts] codex returned empty output');
  process.exit(1);
}

try {
  writeFileSync(outputPath, stdout, 'utf8');
} catch (err) {
  console.error(`[codex.ts] failed to write output file: ${err}`);
  process.exit(1);
}

// Suppress the session created by this synthesis run so the periodic scanner
// never re-synthesizes it (loop prevention).
await suppressSynthesisSession(spawnedAt);

process.exit(0);

// ── Suppression helper ─────────────────────────────────────────────────────────

async function suppressSynthesisSession(since: number): Promise<void> {
  const HOME = process.env.HOME ?? '';
  const now  = new Date();
  const pad  = (n: number) => String(n).padStart(2, '0');
  const dir  = join(HOME, '.codex', 'sessions',
    String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));

  let newFiles: string[];
  try {
    newFiles = readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => statSync(join(dir, f)).mtimeMs >= since);
  } catch {
    return; // sessions dir missing — nothing to suppress
  }

  const stateDir  = join(BACKGROUND_DIR, 'state');
  const statePath = join(stateDir, 'codex.json');

  interface CodexState {
    last_scanned_at?: string;
    processed_sessions?: Array<{ session_id: string; processed_at: string }>;
    suppressed_sessions?: Array<{ session_id: string; suppressed_at: string }>;
  }

  let state: CodexState = {};
  try { state = JSON.parse(await Bun.file(statePath).text()); } catch {}

  const suppressed = state.suppressed_sessions ?? [];
  const suppressedAt = now.toISOString();

  for (const file of newFiles) {
    try {
      const firstLine = (await Bun.file(join(dir, file)).text()).split('\n')[0];
      const parsed = JSON.parse(firstLine);
      const sessionId = parsed?.payload?.session_id as string | undefined;
      if (!sessionId) continue;
      if (!suppressed.some(s => s.session_id === sessionId)) {
        suppressed.push({ session_id: sessionId, suppressed_at: suppressedAt });
      }
    } catch {
      continue;
    }
  }

  state.suppressed_sessions = suppressed;
  try {
    const { mkdirSync } = await import('fs');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    // Non-fatal — worst case the scanner synthesizes the run, producing noise
  }
}
