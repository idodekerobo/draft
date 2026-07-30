import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import {
  cleanupContextSnapshot,
  createContextSnapshot,
  resolveIntelligenceAdapter,
  runIntelligence,
  systemIntelligenceDeps,
  type ContextSnapshot,
  type IntelligenceDeps,
} from './synthesis-runtime';
import { buildMaintainerContractPrompt } from './maintainer-contract';
import { defaultBackgroundDir, workspacePath } from '../integrations/port-runtime-paths';

export interface SlackContext {
  profile?: string;
  analysis_window_hours?: number;
  reconstructed_files?: string[];
  workspace?: string;
}

export function extractDescription(markdown: string): string {
  const match = markdown.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return '';
  const lines = match[1].split('\n');
  const start = lines.findIndex(line => /^description:\s*>?\s*$/.test(line));
  if (start >= 0) {
    const value: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^[A-Za-z_][\w-]*:/.test(line)) break;
      value.push(line.replace(/^\s+/, ''));
    }
    return value.join(' ').trim();
  }
  const scalar = match[1].match(/^description:\s*(.+)$/m);
  return scalar?.[1].trim() || '';
}

function readRoles(workspace: string): string {
  try {
    const roles = JSON.parse(readFileSync(join(workspace, 'config', 'slack-roles.json'), 'utf8')) as Record<string, { name?: string; role?: string }>;
    return Object.entries(roles).filter(([id]) => !id.startsWith('__')).map(([id, info]) => `  ${info.name ?? id} (${info.role ?? 'team member'})`).join('\n');
  } catch { return ''; }
}

export function readPending(workspace: string, read: (path: string) => string = path => readFileSync(path, 'utf8')): { content: string; latestTimestamp: string } {
  const dir = join(workspace, 'proposals');
  try {
    const files = readdirSync(dir).filter(name => name.endsWith('.md')).sort();
    const content = files.map(name => {
      try { return `\n### ${name}\n${read(join(dir, name)).slice(0, 3000)}\n`; }
      catch { return `\n### ${name}\n(unreadable)\n`; }
    }).join('') || '(none)';
    let latestTimestamp = '(no prior synthesis)';
    if (files.length) {
      try {
        const raw = read(join(dir, files.at(-1)!));
        const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
        latestTimestamp = frontmatter.match(/^timestamp:\s*(\S+)/m)?.[1] ?? latestTimestamp;
      } catch {}
    }
    return { content, latestTimestamp };
  } catch { return { content: '(none)', latestTimestamp: '(no prior synthesis)' }; }
}

export function buildSlackPrompt(context: SlackContext, input: {
  workspace: string; profile: string; currentTimestamp: string; intelligence: string;
  outputPath: string; snapshot: ContextSnapshot;
}): string {
  const dimensionContent = input.snapshot.files.map(file =>
    `\n### ${basename(dirname(file.relativePath))}\n${extractDescription(readFileSync(file.snapshotPath, 'utf8'))}\nSnapshot: ${file.snapshotPath}\n`,
  ).join('');
  const channels = (context.reconstructed_files ?? []).filter(existsSync).map(file => `- #${basename(dirname(file))}: ${file}`).join('\n');
  const pending = readPending(input.workspace);
  return `# Draft Synthesis Task — Slack Messages

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## Analysis period
Last ${context.analysis_window_hours ?? 8} hours of Slack activity.
Current time: ${input.currentTimestamp}
Last synthesis: ${pending.latestTimestamp}
Profile: ${input.profile}

## Team roles
Use these roles to weight messages (founder/lead decisions carry more weight):
${readRoles(input.workspace)}

## Slack channel files
Each file contains today's messages for one channel, chronological with threads nested.
Read each file using your Read tool. Use offset/limit on large files.
Focus on messages containing decisions, blockers, shipped work, or open questions.

${channels}

## Workspace context
Current state summaries — read the full file at the listed path only if the summary is insufficient.
${dimensionContent}

## Pending proposals (synthesized but not yet reviewed)
These proposals have been generated from earlier Slack or Granola runs but not yet
applied to the workspace. Do NOT re-capture anything already covered here.

Treat pending proposals as deduplication evidence only. Never replace or modify them.
If you have nothing durable to add beyond the snapshot or pending proposals, choose no_change.
${pending.content}

## Your task
Extract only what would help a teammate start their next AI session with better context.

**SIGNAL — capture:**
- Product decisions or direction changes (look for thread closure, ✅ reactions, founder/lead statements)
- Priority shifts or new constraints
- Technical or architectural decisions
- Customer or user insight surfaced in discussion
- Action items with clear ownership

**NOISE — skip:**
- Logistics, scheduling, casual chat
- Questions without resolution
- Anything already in the workspace context above
- Anything already captured (or superseded) by a pending proposal
- Duplicate tensions already in tensions.md

**Specificity rule:** "Founder decided to shift target user to music directors (Slack #product 2026-05-21)" = SIGNAL.
"Had a discussion about users" = NOISE.

## STRICT RULES
- Do not ask the user inline. Omit vague unsupported messages; when Slack evidence names an unresolved contradiction, return needs_input with both claims and their sources.
- Do NOT copy raw Slack messages verbatim. Write synthesized insights only.
- Do NOT invent information not present in the messages.
- Write ONLY the result document to ${input.outputPath}. No preamble. No commentary.

${buildMaintainerContractPrompt({
    snapshot: input.snapshot,
    metadata: {
      session_id: `slack:${input.currentTimestamp}`,
      input_source: 'slack',
      synthesized_by: input.intelligence,
      timestamp: input.currentTimestamp,
      profile: input.profile,
    },
    outputPath: input.outputPath,
  })}
`;
}

export async function runSlackSynthesis(context: SlackContext, options: {
  workspace?: string; backgroundDir?: string; now?: Date; deps?: IntelligenceDeps;
} = {}): Promise<string> {
  if (!Array.isArray(context.reconstructed_files) || !context.reconstructed_files.some(file => typeof file === 'string' && file.trim())) {
    throw new Error('no reconstructed_files in context');
  }
  const profile = context.profile ?? 'default';
  const workspace = options.workspace ?? context.workspace ?? workspacePath(profile);
  const tmp = join(workspace, 'tmp'); mkdirSync(tmp, { recursive: true });
  const outputPath = join(tmp, `slack-synthesis-${crypto.randomUUID()}`);
  const intelligence = process.env.DRAFT_SLACK_INTELLIGENCE ?? 'claude-code';
  const deps = options.deps ?? systemIntelligenceDeps;
  const snapshot = createContextSnapshot(workspace);
  try {
    return await runIntelligence({
      adapterPath: resolveIntelligenceAdapter(options.backgroundDir ?? defaultBackgroundDir(), intelligence, deps.exists),
      prompt: buildSlackPrompt(context, {
        workspace, profile, outputPath, snapshot,
        currentTimestamp: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'), intelligence,
      }),
      outputPath,
    }, deps);
  } finally {
    cleanupContextSnapshot(snapshot);
    rmSync(outputPath, { force: true });
  }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('context file path required as argv[2]');
  runSlackSynthesis(await Bun.file(path).json()).then(output => process.stdout.write(output)).catch(error => { process.stderr.write(`[slack.ts] ERROR: ${error.message}\n`); process.exit(1); });
}
