import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { activeProfile, defaultBackgroundDir, workspacePath } from '../port-runtime-paths';
import { validateAutomatedSynthesisOutput } from 'draft-core/proposals';
import { resolveRuntimeEntrypoint, runtimeCommand } from 'draft-core/runtime';
import { resolveRunnerBin } from 'draft-core/agents/headless';
import { parseGranolaMode } from '../../synthesizers/granola';

export interface GranolaState { last_checked_at: string | null; processed_meeting_ids: string[] }
export interface GranolaPollContext {
  type: 'granola'; mode: 'mcp' | 'api'; profile: string; timestamp: string;
  last_checked_at: string | null; state_file: string; processed_meeting_ids: string[];
}

export function readGranolaState(path: string): GranolaState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<GranolaState>;
    return { last_checked_at: typeof raw.last_checked_at === 'string' ? raw.last_checked_at : null,
      processed_meeting_ids: Array.isArray(raw.processed_meeting_ids) ? raw.processed_meeting_ids.filter((id): id is string => typeof id === 'string') : [] };
  } catch { return { last_checked_at: null, processed_meeting_ids: [] }; }
}

export function mergeGranolaState(state: GranolaState, timestamp: string, ids: string[]): GranolaState {
  return { last_checked_at: timestamp, processed_meeting_ids: [...new Set([...state.processed_meeting_ids, ...ids.filter(Boolean)])] };
}

export function extractMeetingIds(output: string): string[] {
  const front = output.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const lines = front.split('\n');
  const start = lines.findIndex(line => /^meeting_ids:\s*$/.test(line));
  if (start < 0) return [];
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const match = line.match(/^\s+-\s+(\S.*?)\s*$/);
    if (!match) break;
    if (!match[1].startsWith('[')) ids.push(match[1]);
  }
  return ids;
}

export interface GranolaPollDeps {
  verifyMcp(): Promise<boolean>;
  synthesize(context: GranolaPollContext): Promise<string>;
  write(path: string, content: string): void;
  now(): Date;
  log?(level: 'info' | 'warn' | 'error', message: string): void;
}

export function createGranolaPoller(config: {
  statePath: string; workspace: string; profile: string; mode: 'mcp' | 'api'; token?: string;
}, deps: GranolaPollDeps) {
  let running = false;
  return async function poll(): Promise<'overlap' | 'skipped' | 'empty' | 'staged'> {
    if (running) return 'overlap';
    running = true;
    try {
      const mode = parseGranolaMode(config.mode);
      const state = readGranolaState(config.statePath);
      deps.log?.('info', `starting poll (mode=${mode} last_checked=${state.last_checked_at ?? 'never'})`);
      if (mode === 'mcp' && !await deps.verifyMcp()) { deps.log?.('warn', 'Granola MCP not found — skipping poll'); return 'skipped'; }
      if (mode === 'api' && !config.token) { deps.log?.('warn', 'granola_api_token missing — skipping poll'); return 'skipped'; }
      const timestamp = deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const output = await deps.synthesize({ type: 'granola', mode, profile: config.profile,
        timestamp, last_checked_at: state.last_checked_at, state_file: config.statePath,
        processed_meeting_ids: state.processed_meeting_ids });
      if (!output) {
        deps.write(config.statePath, `${JSON.stringify(mergeGranolaState(state, timestamp, []), null, 2)}\n`);
        deps.log?.('info', `no output; state advanced to ${timestamp}`);
        return 'empty';
      }
      const validation = validateAutomatedSynthesisOutput(output);
      if (!validation.ok) throw new Error(`invalid automated synthesis output: ${validation.error}`);
      const ids = extractMeetingIds(output);
      const next = mergeGranolaState(state, timestamp, ids);
      if (!validation.updates.length) {
        deps.write(config.statePath, `${JSON.stringify(next, null, 2)}\n`);
        deps.log?.('info', `no team-relevant updates; state advanced to ${timestamp}`);
        return 'empty';
      }
      const stamp = timestamp.replace(/[-:]/g, '');
      const proposalPath = join(config.workspace, 'proposals', `${stamp}-granola.md`);
      deps.write(proposalPath, output);
      deps.log?.('info', `staged at ${proposalPath}`);
      deps.write(config.statePath, `${JSON.stringify(next, null, 2)}\n`);
      deps.log?.('info', `state updated (last_checked_at=${timestamp}, new_ids=${ids.length})`);
      return 'staged';
    } finally { running = false; }
  };
}

function durableWrite(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  writeFileSync(tmp, content, { mode: 0o600 }); renameSync(tmp, path);
}

function structuredLog(level: 'info' | 'warn' | 'error', msg: string): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, component: 'granola-poller', msg })}\n`);
}

// Resolves `claude` via known install paths (like the gh/codex pollers), since the
// daemon's PATH is baked at install time and a bare spawn crashes the poll if stale.
export async function verifyGranolaMcp(): Promise<boolean> {
  const claudeBin = await resolveRunnerBin('claude');
  if (!claudeBin) return false;
  const p = Bun.spawn([claudeBin, 'mcp', 'list'], { stdout: 'pipe', stderr: 'ignore' });
  return (await new Response(p.stdout as ReadableStream).text()).toLowerCase().includes('granola') && await p.exited === 0;
}

async function main() {
  const profile = activeProfile(); const workspace = workspacePath(profile); const backgroundDir = defaultBackgroundDir();
  const secretsPath = join(workspace, 'config', 'secrets.json');
  let secrets: Record<string, unknown> = {};
  try { secrets = JSON.parse(readFileSync(secretsPath, 'utf8')); } catch {}
  const mode = parseGranolaMode(process.env.DRAFT_GRANOLA_MODE ?? secrets.granola_mode);
  const poll = createGranolaPoller({ statePath: join(backgroundDir, 'state', 'granola.json'), workspace, profile, mode,
    token: typeof secrets.granola_api_token === 'string' ? secrets.granola_api_token : undefined }, {
    verifyMcp: verifyGranolaMcp,
    async synthesize(context) {
      const contextPath = await writeContext(context);
      try {
        const entrypoint = resolveRuntimeEntrypoint(join(backgroundDir, 'synthesizers', 'granola'));
        const command = entrypoint && runtimeCommand(entrypoint, [contextPath]);
        if (!command) throw new Error('Granola synthesizer runtime not found');
        const p = Bun.spawn(command, { stdout: 'pipe', stderr: 'inherit' });
        const text = await new Response(p.stdout as ReadableStream).text();
        if (await p.exited !== 0) throw new Error('synthesizer failed');
        return text;
      } finally { rmSync(contextPath, { force: true }); }
    },
    write: durableWrite, now: () => new Date(), log: structuredLog,
  });
  await poll();
}

async function writeContext(context: GranolaPollContext): Promise<string> {
  const path = join('/tmp', `draft-granola-${crypto.randomUUID()}.json`); writeFileSync(path, JSON.stringify(context)); return path;
}

if (import.meta.main) main().catch(error => { structuredLog('error', error instanceof Error ? error.message : String(error)); process.exit(1); });
