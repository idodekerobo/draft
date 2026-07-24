import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { contextFileList, discoverContext, resolveIntelligenceAdapter, runIntelligence, systemIntelligenceDeps, type IntelligenceDeps } from './synthesis-runtime';
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
}

export function buildFirefliesPrompt(input: FirefliesPromptInput): string {
  const inventory = discoverContext(input.workspace);
  const files = contextFileList(inventory, '   (none found)');
  const dims = inventory.dimensions.join(',') || '(none found)';
  const processed = input.context.processed_meeting_ids?.length
    ? input.context.processed_meeting_ids.map(id => `  - ${id}`).join('\n')
    : '  (none — first run)';

  return `# Draft Synthesis Task — Fireflies Meeting Transcripts

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## State
profile: ${input.profile}
timestamp: ${input.currentTimestamp}
${input.context.last_checked_at ? `Since your last check: ${input.context.last_checked_at}` : 'No previous check recorded — look back 24 hours.'}

## Existing workspace context
Read these files before synthesizing so you know what's already captured:
${files}
   - ${input.workspace}/context/tensions.md

Read tensions.md before synthesizing — do not add content that contradicts existing context
without routing it as a tension. Do not create duplicate tension entries.

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
- Product or architecture decisions made or discussed
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

**CONTRADICTIONS — use action: tension:**
When new information from the meeting directly contradicts something already in a context file,
do NOT append both versions or overwrite. Route it as a tension entry:
  - file: context/tensions.md
    action: tension
    content: |
      ### [short name for the contradiction]
      - **Observed:** [YYYY-MM-DD]
      - **Signal:** Meeting says "[new value]" but [context/file] says "[existing value]"
      - **Status:** unresolved
      - **Resolution:**
Do NOT update the dimension file — the contradiction stays visible until the curator resolves it.
Only create a tension if it is not already present in context/tensions.md.

**If no new meetings, or no team-relevant content:** write the document with empty context_updates: [].

## Output format
Write ONLY the following structure to: ${input.outputPath}
Use ONLY context dimensions that exist in context/ (${dims}). Three actions are allowed:
- "append" — new information that complements existing context
- "tension" — contradictions; always file: context/tensions.md
- "overwrite" — DO NOT USE in synthesis; reserved for /draft:compact only

---
input_source: fireflies
synthesized_by: ${input.intelligence}
timestamp: ${input.currentTimestamp}
profile: ${input.profile}
meeting_ids:
  - [id of each meeting synthesized — from the meeting ID returned by fireflies_get_transcripts]
context_updates:
  - file: context/product/index.md
    action: append
    content: |
      [specific synthesized insight]
---

## Synthesis preview
### context/product/index.md — append
[same content as above]

## STRICT RULES
- Do NOT ask questions. Do NOT seek clarification. If ambiguous, omit.
- Do NOT copy raw transcript text. Write synthesized insights only.
- Do NOT invent information not present in the transcript.
- For contradictions: ALWAYS use action: tension with file: context/tensions.md. Never overwrite to resolve a contradiction — that is the curator's decision, not the synthesizer's.
- Write ONLY the document above to ${input.outputPath}. No preamble. No commentary.
- After writing the file, type /exit to end the session.
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
  try {
    return await runIntelligence({
      adapterPath: resolveIntelligenceAdapter(options.backgroundDir ?? defaultBackgroundDir(), intelligence, deps.exists),
      prompt: buildFirefliesPrompt({ context, workspace, profile, outputPath, currentTimestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), intelligence }),
      outputPath,
    }, deps);
  } finally { rmSync(outputPath, { force: true }); }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('context file path required as argv[2]');
  runFirefliesSynthesis(await Bun.file(path).json()).then(output => process.stdout.write(output)).catch(error => { process.stderr.write(`[fireflies.ts] ERROR: ${error.message}\n`); process.exit(1); });
}
