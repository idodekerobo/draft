import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
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

export interface CodexSessionJob {
  session_id?: string;
  transcript_path?: string;
  timestamp?: string;
  profile?: string;
  cwd?: string;
}

interface CodexLine {
  type: string;
  payload?: Record<string, unknown>;
}

interface ContentItem {
  type: string;
  text?: string;
}

export interface CodexSessionPromptInput {
  job: CodexSessionJob;
  profile: string;
  outputPath: string;
  currentTimestamp: string;
  intelligence: string;
  conversationText: string;
  snapshot: ContextSnapshot;
}

export function parseCodexConversation(transcript: string): string {
  const parts: string[] = [];
  for (const raw of transcript.split('\n').filter(Boolean)) {
    let line: CodexLine;
    try { line = JSON.parse(raw) as CodexLine; } catch { continue; }
    const payload = line.payload;
    if (!payload) continue;
    if (line.type === 'event_msg' && payload.type === 'user_message') {
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (message) parts.push(`User: ${message}`);
    }
    if (line.type === 'response_item' && payload.role === 'assistant') {
      const content = payload.content as ContentItem[] | undefined;
      if (!Array.isArray(content)) continue;
      const message = content
        .filter(item => item.type === 'output_text' && item.text)
        .map(item => item.text!.trim())
        .join('\n')
        .trim();
      if (message) parts.push(`Assistant: ${message}`);
    }
  }
  return parts.join('\n\n');
}

export function buildCodexSessionPrompt(input: CodexSessionPromptInput): string {
  const sessionId = input.job.session_id ?? 'unknown';
  return `# Draft Synthesis Task — Codex Session Transcript

## Session metadata
session_id: ${sessionId}
profile: ${input.profile}
timestamp: ${input.job.timestamp ?? ''}
cwd: ${input.job.cwd ?? ''}

## Conversation transcript
${input.conversationText}

## Source-specific judgment
Extract only durable decisions, product direction, constraints, architectural rationale, and team-relevant facts.
Skip debugging, abandoned exploration, implementation minutiae, and anything already captured.
Do not copy raw conversation excerpts or invent information. Omit vague unsupported material; when evidence names an unresolved contradiction, return needs_input with both claims and their sources.

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

export async function runCodexSession(job: CodexSessionJob, options: {
  workspace?: string;
  backgroundDir?: string;
  now?: Date;
  deps?: IntelligenceDeps;
} = {}): Promise<string> {
  const profile = job.profile ?? process.env.DRAFT_ACTIVE_PROFILE ?? 'default';
  const workspace = options.workspace ?? workspacePath(profile);
  const transcriptPath = job.transcript_path ?? '';
  if (!transcriptPath || !existsSync(transcriptPath)) {
    throw new Error(`transcript not found: ${transcriptPath}`);
  }
  const conversationText = parseCodexConversation(readFileSync(transcriptPath, 'utf8'));
  if (!conversationText) return '';

  const tmp = join(workspace, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const outputPath = join(tmp, `codex-synthesis-${crypto.randomUUID()}`);
  const intelligence = process.env.DRAFT_SESSION_INTELLIGENCE ?? 'claude-code';
  const deps = options.deps ?? systemIntelligenceDeps;
  const snapshot = createContextSnapshot(workspace);
  try {
    return await runIntelligence({
      adapterPath: resolveIntelligenceAdapter(
        options.backgroundDir ?? defaultBackgroundDir(),
        intelligence,
        deps.exists,
      ),
      prompt: buildCodexSessionPrompt({
        job,
        profile,
        outputPath,
        intelligence,
        conversationText,
        snapshot,
        currentTimestamp: (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      }),
      outputPath,
    }, deps);
  } finally {
    cleanupContextSnapshot(snapshot);
    rmSync(outputPath, { force: true });
  }
}

async function main(): Promise<void> {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('job file path required as argv[2]');
  const job = JSON.parse(await Bun.file(jobPath).text()) as CodexSessionJob;
  process.stdout.write(await runCodexSession(job));
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`[codex-session.ts] ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
