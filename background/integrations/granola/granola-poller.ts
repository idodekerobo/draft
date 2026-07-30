import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { activeProfile, defaultBackgroundDir, workspacePath } from '../port-runtime-paths';
import { resolveRuntimeEntrypoint, runtimeCommand } from 'draft-core/runtime';
import { resolveRunnerBin } from 'draft-core/agents/headless';
import { parseGranolaMode } from '../../synthesizers/granola';
import {
  routeAutomatedMaintainerOutput,
  type AutomatedMaintainerRouteResult,
} from '../../automated-maintainer-router';

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

export interface GranolaPollDeps {
  verifyMcp(): Promise<boolean>;
  synthesize(context: GranolaPollContext): Promise<string>;
  write(path: string, content: string): void;
  now(): Date;
  route?(output: string, timestamp: string): AutomatedMaintainerRouteResult;
  log?(level: 'info' | 'warn' | 'error', message: string): void;
}

export function createGranolaPoller(config: {
  statePath: string; workspace: string; profile: string; mode: 'mcp' | 'api'; token?: string;
}, deps: GranolaPollDeps) {
  let running = false;
  return async function poll(): Promise<'overlap' | 'skipped' | 'empty' | 'applied' | 'flagged' | 'deferred'> {
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
      const routed = deps.route
        ? deps.route(output, timestamp)
        : routeAutomatedMaintainerOutput(output, {
            job_id: `granola:${timestamp}`,
            input_source: 'granola',
            synthesized_by: process.env.DRAFT_GRANOLA_INTELLIGENCE ?? 'claude-code',
            timestamp,
            profile: config.profile,
          }, config.workspace);
      if (routed.status === 'locked') {
        deps.log?.('info', 'workspace busy — deferring; state not advanced');
        return 'deferred';
      }
      const ids = routed.meetingIds;
      const next = mergeGranolaState(state, timestamp, ids);
      deps.write(config.statePath, `${JSON.stringify(next, null, 2)}\n`);
      deps.log?.('info', `state updated (last_checked_at=${timestamp}, new_ids=${ids.length})`);
      if (routed.status === 'flagged') {
        deps.log?.('warn', `flagged for review at ${routed.flaggedPath}`);
        return 'flagged';
      }
      if (routed.outcome === 'rewrite') {
        deps.log?.('info', 'context updated automatically');
        return 'applied';
      }
      deps.log?.('info', 'no team-relevant updates');
      return 'empty';
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
export async function verifyGranolaMcp(
  resolve = resolveRunnerBin,
): Promise<boolean> {
  const claudeBin = await resolve('claude');
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
