import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { basename, dirname, join } from 'path';
import { discoverContext, resolveIntelligenceAdapter, runIntelligence, systemIntelligenceDeps, type IntelligenceDeps } from './synthesis-runtime';
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

export function readReplacesProposal(output: string): string | null {
  const frontmatter = output.match(/^---\n([\s\S]*?)\n---/);
  return frontmatter?.[1].match(/^replaces_proposal:\s*(\S+)/m)?.[1] ?? null;
}

export const SLACK_PROPOSAL_FILENAME = /^\d{8}T\d{6}Z-(?:slack|granola)\.md$/;

export function safeReplacementPath(proposalsDir: string, requested: string | null, exists: (path: string) => boolean = existsSync): string | null {
  if (!requested || basename(requested) !== requested || requested.includes('..')) return null;
  if (!SLACK_PROPOSAL_FILENAME.test(requested)) return null;
  const target = join(proposalsDir, requested);
  return exists(target) ? target : null;
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
}): string {
  const inventory = discoverContext(input.workspace);
  const dimensionContent = inventory.files.map(file => `\n### ${basename(dirname(file))}\n${extractDescription(readFileSync(file, 'utf8'))}\nFull file (read if needed): ${file}\n`).join('');
  const channels = (context.reconstructed_files ?? []).filter(existsSync).map(file => `- #${basename(dirname(file))}: ${file}`).join('\n');
  const pending = readPending(input.workspace);
  let tensions = '(no tensions file found)';
  try { tensions = readFileSync(join(input.workspace, 'context', 'tensions.md'), 'utf8'); } catch {}
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

## Active tensions
${tensions}

## Pending proposals (synthesized but not yet reviewed)
These proposals have been generated from earlier Slack or Granola runs but not yet
applied to the workspace. Do NOT re-capture anything already covered here.

If recent Slack messages update or supersede a pending proposal — new resolution on
the same decision, a direction that has since changed, more specificity on an action
item — you may OVERWRITE that proposal instead of creating a new one. To overwrite,
include this field at the top of your YAML frontmatter:
  replaces_proposal: <exact filename, e.g. 20260522T004806Z-slack.md>

If you have nothing to add beyond what is already in the workspace context or pending
proposals, output the document with empty context_updates.
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

**CONTRADICTIONS — use action: tension:**
When Slack content directly contradicts existing context, route it as a tension:
  - file: context/tensions.md
    action: tension
    content: |
      ### [short name for the contradiction]
      - **Observed:** [YYYY-MM-DD]
      - **Signal:** Slack says "[new value]" but [context/file] says "[existing value]"
      - **Status:** unresolved
      - **Resolution:**

## Output format
Write ONLY the following structure. Three actions allowed for context_updates:
- "append" — new info that complements existing context
- "tension" — contradiction; always file: context/tensions.md
- "overwrite" — DO NOT USE in context_updates

The optional top-level field replaces_proposal names an existing proposal file to
overwrite rather than creating a new one. Omit it when creating a fresh proposal.

---
replaces_proposal: 20260522T004806Z-slack.md   # optional — omit if creating new
input_source: slack
synthesized_by: ${input.intelligence}
timestamp: ${input.currentTimestamp}
profile: ${input.profile}
context_updates:
  - file: context/product/index.md
    action: append
    content: |
      [specific synthesized insight here]
---

## Synthesis preview
### context/product/index.md — append
[same content, human-readable]

## STRICT RULES
- Do NOT ask questions. If ambiguous, omit.
- Do NOT copy raw Slack messages verbatim. Write synthesized insights only.
- Do NOT invent information not present in the messages.
- For contradictions: ALWAYS use action: tension with file: context/tensions.md.
- replaces_proposal must be an exact filename from the pending proposals list above.
- Write ONLY the document above to stdout. No preamble. No commentary.
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
  try {
    return await runIntelligence({
      adapterPath: resolveIntelligenceAdapter(options.backgroundDir ?? defaultBackgroundDir(), intelligence, deps.exists),
      prompt: buildSlackPrompt(context, { workspace, profile, currentTimestamp: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'), intelligence }),
      outputPath,
    }, deps);
  } finally { rmSync(outputPath, { force: true }); }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('context file path required as argv[2]');
  runSlackSynthesis(await Bun.file(path).json()).then(output => process.stdout.write(output)).catch(error => { process.stderr.write(`[slack.ts] ERROR: ${error.message}\n`); process.exit(1); });
}
