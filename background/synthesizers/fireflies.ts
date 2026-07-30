import { mkdirSync, rmSync } from 'fs';
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

export interface FirefliesContext {
  profile?: string;
  last_checked_at?: string | null;
  processed_meeting_ids?: string[];
}

export interface FirefliesPromptInput {
  context: FirefliesContext;
  workspace: string;
  profile: string;
  outputPath: string;
  currentTimestamp: string;
  intelligence: string;
  snapshot: ContextSnapshot;
}

export function buildFirefliesPrompt(input: FirefliesPromptInput): string {
  const processed = input.context.processed_meeting_ids?.length
    ? input.context.processed_meeting_ids.map(id => `  - ${id}`).join('\n')
    : '  (none — first run)';

  return `# Draft Synthesis Task — Fireflies Meeting Transcripts

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## State
profile: ${input.profile}
timestamp: ${input.currentTimestamp}
${input.context.last_checked_at ? `Since your last check: ${input.context.last_checked_at}` : 'No previous check recorded — look back 24 hours.'}

## Your task

**Available Fireflies MCP tools**
| Tool | What it returns |
|------|----------------|
| \`fireflies_get_transcripts\` | List of recent transcripts with filters and summaries |
| \`fireflies_get_transcript\` | Full transcript for a specific meeting ID |
| \`fireflies_get_summary\` | Action items and keywords for a specific meeting ID |

**Already-processed meeting IDs — skip these entirely:**
${processed}

**Step 1 — Fetch meetings via Fireflies MCP**
1. Call \`fireflies_get_transcripts\` to find recent meetings.
2. For each meeting returned:
   - Skip if its ID is in the already-processed list above
   - Skip any meeting that ended less than 30 minutes ago (transcript may be incomplete)
   - Call \`fireflies_get_summary\` with the meeting ID to fetch action items and keywords
   - If you need verbatim quotes or more granular detail, also call \`fireflies_get_transcript\`

**Step 2 — Synthesize context updates**
Extract only what would help a teammate start their next AI session with better shared context.

**SIGNAL — capture:**
- Product or architecture decisions made
- Action items with clear owners (especially ones affecting the product/team)
- Direction changes, new constraints, or validated/invalidated assumptions
- Team-relevant facts learned about users, customers, competitors, or the market

**NOISE — skip:**
- Small talk, scheduling discussion, logistics
- Items already captured in the existing context files above
- Speculative ideas with no decision or action
- Implementation minutiae

**Specificity rule:** "Decided to drop the REST polling path in favor of MCP after
confirming the bearer token is required either way" = SIGNAL.
"Discussed technical options" = NOISE.

## STRICT RULES
- Do not ask the user inline. Omit vague unsupported discussion; when the meeting evidence names an unresolved contradiction, return needs_input with both claims and their sources.
- Do NOT copy raw transcript text. Write synthesized insights only.
- Do NOT invent information not present in the transcript.
- Write ONLY the document above to ${input.outputPath}. No preamble. No commentary.
- After writing the file, type /exit to end the session.

For every outcome, add the \`meeting_ids:\` list to the single YAML frontmatter with the IDs of every meeting analyzed. Use an empty list when none were analyzed.

${buildMaintainerContractPrompt({
    snapshot: input.snapshot,
    metadata: {
      session_id: `fireflies:${input.currentTimestamp}`,
      input_source: 'fireflies',
      synthesized_by: input.intelligence,
      timestamp: input.currentTimestamp,
      profile: input.profile,
    },
    outputPath: input.outputPath,
  })}
`;
}

export async function runFirefliesSynthesis(context: FirefliesContext, options: {
  workspace?: string; backgroundDir?: string; now?: Date; deps?: IntelligenceDeps;
} = {}): Promise<string> {
  const deps = options.deps ?? systemIntelligenceDeps;
  const profile = context.profile ?? 'default';
  const workspace = options.workspace ?? workspacePath(profile);
  const now = options.now ?? new Date();
  const tmp = join(workspace, 'tmp'); mkdirSync(tmp, { recursive: true });
  const outputPath = join(tmp, `fireflies-synthesis-${crypto.randomUUID()}`);
  const intelligence = process.env.DRAFT_FIREFLIES_INTELLIGENCE ?? 'claude-code';
  const snapshot = createContextSnapshot(workspace);
  try {
    return await runIntelligence({
      adapterPath: resolveIntelligenceAdapter(options.backgroundDir ?? defaultBackgroundDir(), intelligence, deps.exists),
      prompt: buildFirefliesPrompt({
        context, workspace, profile, outputPath, snapshot,
        currentTimestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), intelligence,
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
  runFirefliesSynthesis(await Bun.file(path).json()).then(output => process.stdout.write(output)).catch(error => { process.stderr.write(`[fireflies.ts] ERROR: ${error.message}\n`); process.exit(1); });
}
