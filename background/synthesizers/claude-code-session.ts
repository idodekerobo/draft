import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
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
  snapshot: ContextSnapshot;
  intelligence: string;
}

export function buildClaudeSessionPrompt(input: ClaudeSessionPromptInput): string {
  const sessionId = input.job.session_id ?? 'unknown';
  const transcript = input.job.transcript_path ?? '';
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

## STRICT RULES
- Do not ask the user inline. If the evidence contains a named unresolved contradiction, return needs_input with both competing claims and their sources; omit merely vague or unsupported material.
- Do NOT copy raw transcript excerpts. Write synthesized insights only.
- Do NOT invent information not present in the transcript.
- Write ONLY the document above to ${input.outputPath}. No preamble. No commentary.
- After writing the file, type /exit to end the session.

${buildMaintainerContractPrompt({
    snapshot: input.snapshot,
    metadata: {
      session_id: sessionId,
      input_source: 'session',
      synthesized_by: input.intelligence,
      timestamp: input.currentTimestamp,
      profile: input.profile,
    },
    outputPath: input.outputPath,
  })}
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
  const snapshot = createContextSnapshot(workspace);
  try {
    return await runIntelligence({
      adapterPath: resolveIntelligenceAdapter(options.backgroundDir ?? defaultBackgroundDir(), intelligence, deps.exists),
      prompt: buildClaudeSessionPrompt({
        job, workspace, profile, outputPath, snapshot, intelligence,
        currentTimestamp: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }),
      outputPath,
    }, deps);
  } finally {
    cleanupContextSnapshot(snapshot);
    rmSync(outputPath, { force: true });
  }
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('job file path required as argv[2]');
  const job = await Bun.file(jobPath).json() as ClaudeSessionJob;
  process.stdout.write(await runClaudeSession(job));
}

if (import.meta.main) main().catch(error => { process.stderr.write(`[claude-code-session.ts] ERROR: ${error.message}\n`); process.exit(1); });
