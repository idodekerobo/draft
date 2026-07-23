import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { readReplacesProposal, safeReplacementPath } from '../../synthesizers/slack';
import { activeProfile, defaultBackgroundDir, workspacePath } from '../port-runtime-paths';
import { validateAutomatedSynthesisOutput } from 'draft-core/proposals';
import { resolveRuntimeEntrypoint, runtimeCommand } from 'draft-core/runtime';

export interface SlackAnalyzerDeps {
  rebuild(input: { channel: string; channelName: string; hours: number }): Promise<string | null>;
  synthesize(context: Record<string, unknown>): Promise<string>;
  exists(path: string): boolean;
  write(path: string, content: string): void;
  now(): Date;
  log?(level: 'info' | 'warn' | 'error', message: string): void;
}

export function parseSlackRuntimeConfig(secrets: unknown, roles: unknown, rawWindow: unknown): {
  channels: string[]; channelNames: Record<string, string>; hours: number;
} {
  const secretsRecord = secrets && typeof secrets === 'object' && !Array.isArray(secrets) ? secrets as Record<string, unknown> : {};
  const channels = Array.isArray(secretsRecord.slack_allowlist_channels)
    ? secretsRecord.slack_allowlist_channels.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean)
    : [];
  const rolesRecord = roles && typeof roles === 'object' && !Array.isArray(roles) ? roles as Record<string, unknown> : {};
  const rawNames = rolesRecord.__channels && typeof rolesRecord.__channels === 'object' && !Array.isArray(rolesRecord.__channels)
    ? rolesRecord.__channels as Record<string, unknown> : {};
  const channelNames = Object.fromEntries(Object.entries(rawNames).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const parsedWindow = Number(rawWindow);
  return { channels, channelNames, hours: Number.isFinite(parsedWindow) && parsedWindow > 0 ? parsedWindow : 8 };
}

export function createSlackAnalyzer(config: {
  workspace: string; profile: string; channels: string[]; channelNames?: Record<string, string>; hours: number;
}, deps: SlackAnalyzerDeps) {
  let running = false;
  return async function analyze(): Promise<'overlap' | 'empty' | 'staged' | 'replaced'> {
    if (running) return 'overlap';
    running = true;
    try {
      deps.log?.('info', `starting analysis (channels=${config.channels.join(' ')} window=${config.hours}h)`);
      const reconstructed: string[] = [];
      for (const channel of config.channels) {
        const file = await deps.rebuild({ channel, channelName: config.channelNames?.[channel] ?? channel, hours: config.hours });
        if (file && deps.exists(file)) { reconstructed.push(file); deps.log?.('info', `rebuilt ${channel} → ${file}`); }
        else deps.log?.('info', `no messages for ${channel} — skipping`);
      }
      if (!reconstructed.length) { deps.log?.('info', 'no reconstructed files — nothing to synthesize'); return 'empty'; }
      const timestamp = deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const output = await deps.synthesize({ type: 'slack', profile: config.profile, timestamp,
        analysis_window_hours: config.hours, channels: config.channels, reconstructed_files: reconstructed,
        workspace: config.workspace });
      if (!output) { deps.log?.('info', 'no synthesis output — nothing team-relevant found'); return 'empty'; }
      const validation = validateAutomatedSynthesisOutput(output);
      if (!validation.ok) throw new Error(`invalid automated synthesis output: ${validation.error}`);
      if (!validation.updates.length) { deps.log?.('info', 'synthesizer found no team-relevant updates'); return 'empty'; }
      const proposals = join(config.workspace, 'proposals');
      const replacement = safeReplacementPath(proposals, readReplacesProposal(output), deps.exists);
      if (replacement) { deps.write(replacement, output); deps.log?.('info', `overwrote existing proposal: ${replacement}`); return 'replaced'; }
      const stamp = timestamp.replace(/[-:]/g, '');
      deps.write(join(proposals, `${stamp}-slack.md`), output);
      deps.log?.('info', `staged at ${join(proposals, `${stamp}-slack.md`)}`);
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
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), level, component: 'slack-analyzer', msg })}\n`);
}

async function main() {
  const profile = activeProfile(); const workspace = workspacePath(profile); const backgroundDir = defaultBackgroundDir();
  let secrets: Record<string, unknown> = {}; let roles: Record<string, unknown> = {};
  try { secrets = JSON.parse(readFileSync(join(workspace, 'config', 'secrets.json'), 'utf8')); } catch {}
  try { roles = JSON.parse(readFileSync(join(workspace, 'config', 'slack-roles.json'), 'utf8')); } catch {}
  const runtime = parseSlackRuntimeConfig(secrets, roles, process.env.DRAFT_SLACK_ANALYSIS_WINDOW ?? 8);
  if (!runtime.channels.length) { structuredLog('warn', 'no channels configured in secrets.json — skipping analysis'); return; }
  const analyzer = createSlackAnalyzer({ workspace, profile, channels: runtime.channels, channelNames: runtime.channelNames, hours: runtime.hours }, {
    async rebuild({ channel, channelName, hours }) {
      const entrypoint = resolveRuntimeEntrypoint(join(backgroundDir, 'integrations/slack/slack-rebuild'));
      const command = entrypoint && runtimeCommand(entrypoint, ['--channel', channel, '--channel-name', channelName, '--hours', String(hours), '--capture-dir', join(backgroundDir, 'integrations/slack/captures')]);
      if (!command) throw new Error('Slack rebuild runtime not found');
      const p = Bun.spawn(command, { stdout: 'pipe', stderr: 'inherit' });
      const out = (await new Response(p.stdout as ReadableStream).text()).trim();
      return await p.exited === 0 && out ? out : null;
    },
    async synthesize(context) {
      const path = join('/tmp', `draft-slack-${crypto.randomUUID()}.json`); writeFileSync(path, JSON.stringify(context));
      try {
        const entrypoint = resolveRuntimeEntrypoint(join(backgroundDir, 'synthesizers/slack'));
        const command = entrypoint && runtimeCommand(entrypoint, [path]);
        if (!command) throw new Error('Slack synthesizer runtime not found');
        const p = Bun.spawn(command, { stdout: 'pipe', stderr: 'inherit' });
        const out = await new Response(p.stdout as ReadableStream).text();
        if (await p.exited !== 0) throw new Error('synthesizer failed');
        return out;
      } finally { rmSync(path, { force: true }); }
    },
    exists: existsSync, write: durableWrite, now: () => new Date(), log: structuredLog,
  });
  await analyzer();
}

if (import.meta.main) main().catch(error => { structuredLog('error', error instanceof Error ? error.message : String(error)); process.exit(1); });
