import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { contextFileList, discoverContext, resolveIntelligenceAdapter, runIntelligence, systemIntelligenceDeps, type IntelligenceDeps } from './synthesis-runtime';
import { defaultBackgroundDir, workspacePath } from '../integrations/port-runtime-paths';

export interface ClaudeSessionJob {
  session_id?: string;
  transcript_path?: string;
  timestamp?: string;
  profile?: string;
}

export interface ClaudeSessionPromptInput {
  job: ClaudeSessionJob;
  workspace: string;
  profile: string;
  outputPath: string;
  currentTimestamp: string;
}

export function buildClaudeSessionPrompt(input: ClaudeSessionPromptInput): string {
  const sessionId = input.job.session_id ?? 'unknown';
  const transcript = input.job.transcript_path ?? '';
  const inventory = discoverContext(input.workspace);
  const files = contextFileList(inventory, '   (no context files found — workspace may not be initialized)');
  const dims = inventory.dimensions.length ? inventory.dimensions.join(',') : '(none found)';
  return `# Draft Synthesis Task — Session Transcript

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## Session metadata
session_id: ${sessionId}
profile: ${input.profile}
timestamp: ${input.job.timestamp ?? ''}

## Files to read
1. Session transcript (full): ${transcript}
   This file may be large. Read it using your Read tool with offset/limit parameters if needed.
   Focus on: decisions made, product direction stated, blockers surfaced, feature scope changes.
   You do NOT need to read every line — scan for signal, then go deeper where relevant.
2. Existing workspace context (to know what's already captured):
${files}
   - ${input.workspace}/context/tensions.md

Read these files before writing your synthesis. Reading tensions.md tells you what
contradictions are already flagged — do not create duplicate tension entries.

## Your task
Analyze the session transcript. Extract only what would help a teammate
start their next AI session with better shared context.

**SIGNAL — capture:**
- Architectural or design decisions (and the reasoning)
- Product direction changes or new constraints
- Key technical patterns or approaches established
- Team-relevant facts learned (about the codebase, users, processes)

**NOISE — skip:**
- Debugging sessions or one-off error fixes
- Exploratory work that led nowhere
- Implementation minutiae (variable names, formatting, etc.)
- Anything already captured in the existing context files above

**Specificity rule:** "Decided to use separate-clone pattern for GitHub
publishing to avoid git init in the Draft workspace" = SIGNAL.
"Made some technical decisions" = NOISE.

**CONTRADICTIONS — use action: tension:**
When new information directly contradicts something already in a context file, do NOT
append both versions or overwrite. Route it as a tension entry:
  - file: context/tensions.md
    action: tension
    content: |
      ### [short name for the contradiction]
      - **Observed:** [YYYY-MM-DD]
      - **Signal:** Session says "[new value]" but [context/file] says "[existing value]"
      - **Status:** unresolved
      - **Resolution:**
Do NOT update the dimension file — the contradiction stays visible until the curator resolves it.
Only create a tension if it is not already present in context/tensions.md.

**If nothing team-relevant happened:** write the document with empty context_updates.

## Output format
Write ONLY the following structure to: ${input.outputPath}

Replace the bracketed sections with real content. Use ONLY files that exist in
context/ (${dims}). Three actions are allowed:
- "append"   — new information that complements existing context (default for all synthesis)
- "tension"  — new info contradicts existing context; always set file: context/tensions.md
- "overwrite" — do NOT use in synthesis; reserved for curator-triggered compaction only

---
session_id: ${sessionId}
input_source: session
synthesized_by: ${process.env.DRAFT_SESSION_INTELLIGENCE ?? 'claude-code'}
timestamp: ${input.currentTimestamp}
profile: ${input.profile}
context_updates:
  - file: context/product/index.md
    action: append
    content: |
      [one or more specific lines to add]
---

## Synthesis preview

### context/product/index.md — append
[same content as above, formatted as readable markdown]

## STRICT RULES
- Do NOT ask questions. Do NOT seek clarification. If ambiguous, omit.
- Do NOT copy raw transcript excerpts. Write synthesized insights only.
- Do NOT invent information not present in the transcript.
- For contradictions: ALWAYS use action: tension with file: context/tensions.md. Never overwrite to resolve a contradiction — that is the curator's decision, not the synthesizer's.
- Write ONLY the document above to ${input.outputPath}. No preamble. No commentary.
- After writing the file, type /exit to end the session.
`;
}

export async function runClaudeSession(job: ClaudeSessionJob, options: {
  workspace?: string; backgroundDir?: string; now?: Date; deps?: IntelligenceDeps;
} = {}): Promise<string> {
  const profile = job.profile ?? process.env.DRAFT_ACTIVE_PROFILE ?? 'default';
  const workspace = options.workspace ?? workspacePath(profile);
  const transcript = job.transcript_path ?? '';
  if (!transcript) throw new Error('transcript_path missing from job file');
  if (!existsSync(transcript)) throw new Error(`transcript not found: ${transcript}`);
  const tmp = join(workspace, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const outputPath = join(tmp, `synthesis-${crypto.randomUUID()}`);
  const intelligence = process.env.DRAFT_SESSION_INTELLIGENCE ?? 'claude-code';
  const deps = options.deps ?? systemIntelligenceDeps;
  try {
    return await runIntelligence({
      adapterPath: resolveIntelligenceAdapter(options.backgroundDir ?? defaultBackgroundDir(), intelligence, deps.exists),
      prompt: buildClaudeSessionPrompt({ job, workspace, profile, outputPath, currentTimestamp: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z') }),
      outputPath,
    }, deps);
  } finally { rmSync(outputPath, { force: true }); }
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('job file path required as argv[2]');
  const job = await Bun.file(jobPath).json() as ClaudeSessionJob;
  process.stdout.write(await runClaudeSession(job));
}

if (import.meta.main) main().catch(error => { process.stderr.write(`[claude-code-session.ts] ERROR: ${error.message}\n`); process.exit(1); });
