import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { contextFileList, discoverContext, resolveIntelligenceAdapter, runIntelligence, systemIntelligenceDeps, type IntelligenceDeps } from './synthesis-runtime';
import { defaultBackgroundDir, workspacePath } from '../integrations/port-runtime-paths';

export type GranolaMode = 'mcp' | 'api';
export interface GranolaContext {
  profile?: string;
  mode?: GranolaMode;
  last_checked_at?: string | null;
  processed_meeting_ids?: string[];
}

export interface GranolaNote {
  id?: string;
  title?: string;
  name?: string;
  transcript?: string;
  content?: string;
  created_at?: string;
  createdAt?: string;
}

export function parseGranolaMode(value: unknown): GranolaMode {
  if (value === undefined || value === null || value === '') return 'mcp';
  if (value === 'mcp' || value === 'api') return value;
  throw new Error(`unknown Granola mode: ${String(value)}`);
}

export function filterApiMeetings(payload: unknown, lastCheckedAt: string | null, now: Date): GranolaNote[] {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const notes = Array.isArray(payload) ? payload : Array.isArray(record.notes) ? record.notes : Array.isArray(record.data) ? record.data : [];
  const parsedSince = lastCheckedAt ? Date.parse(lastCheckedAt) : Number.NaN;
  const since = Number.isNaN(parsedSince) ? Number.NEGATIVE_INFINITY : parsedSince;
  const completeBefore = now.getTime() - 30 * 60_000;
  return notes.filter((value): value is GranolaNote => {
    if (!value || typeof value !== 'object') return false;
    const note = value as GranolaNote;
    if (!(note.transcript || note.content)) return false;
    const created = Date.parse(note.created_at ?? note.createdAt ?? '');
    return Number.isNaN(created) || (created > since && created <= completeBefore);
  });
}

export function formatApiMeetings(notes: GranolaNote[]): string {
  return notes.map(note => `=== ${note.title ?? note.name ?? 'Untitled meeting'} ===\n${note.transcript || note.content || ''}\n`).join('\n');
}

export interface GranolaPromptInput {
  context: GranolaContext;
  workspace: string;
  profile: string;
  outputPath: string;
  currentTimestamp: string;
  intelligence: string;
  transcriptContent?: string;
}

export function buildGranolaPrompt(input: GranolaPromptInput): string {
  const inventory = discoverContext(input.workspace);
  const files = contextFileList(inventory, '   (none found)');
  const dims = inventory.dimensions.join(',') || '(none found)';
  const mode = parseGranolaMode(input.context.mode);
  const processed = input.context.processed_meeting_ids?.length
    ? input.context.processed_meeting_ids.map(id => `  - ${id}`).join('\n')
    : '  (none — first run)';
  const source = mode === 'mcp' ? `## Your task

**Available Granola MCP tools**
| Tool | What it returns |
|------|----------------|
| \`query_granola_meetings\` | Natural language search across all meeting content |
| \`list_meetings\` | Meeting ID, title, date, attendees (+ shared notes on paid plans) |
| \`get_meetings\` | Full meeting content: ID, title, date, attendees, private notes, enhanced notes |
| \`get_meeting_transcript\` | Raw transcript for a specific meeting ID (paid plans only) |
| \`list_meeting_folders\` | Folders you're a member of with ID, title, description, note count (paid plans only) |
| \`get_account_info\` | Email and active workspace for the connected Granola account |

**Already-processed meeting IDs — skip these entirely:**
${processed}

**Step 1 — Fetch meetings via Granola MCP**
1. Call \`list_meetings\` to find recent meetings (use time_range "this_week" or "today").
2. For each meeting returned:
   - Skip if its ID is in the already-processed list above
   - Skip any meeting that ended less than 30 minutes ago (transcript may be incomplete)
   - Call \`get_meetings\` with the meeting ID to fetch full content including notes
   - If you need verbatim quotes or more granular detail, also call \`get_meeting_transcript\`

**Step 2 — Synthesize context updates**`
    : `## Meeting transcripts to synthesize

${input.transcriptContent ?? ''}

## Your task`;
  const meetingIdsOutput = mode === 'mcp' ? `meeting_ids:
  - [id of each meeting synthesized — from the meeting ID returned by list_meetings/get_meetings]
` : '';
  const noUpdates = mode === 'mcp'
    ? '**If no new meetings, or no team-relevant content:** write the document with empty context_updates: [].'
    : '**If no team-relevant content:** write the document with empty context_updates: [].';
  return `# Draft Synthesis Task — Granola Meeting Transcripts

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## State
profile: ${input.profile}
timestamp: ${input.currentTimestamp}
${mode === 'mcp' ? (input.context.last_checked_at ? `Since your last check: ${input.context.last_checked_at}` : 'No previous check recorded — look back 24 hours.') : `last_checked_at: ${input.context.last_checked_at ?? 'never'}`}

## Existing workspace context
Read these files before synthesizing so you know what's already captured:
${files}
   - ${input.workspace}/context/tensions.md

Read tensions.md before synthesizing — do not add content that contradicts existing context
without routing it as a tension. Do not create duplicate tension entries.

${source}
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

**Specificity rule:** "Decided to drop Granola API polling in favor of MCP after
confirming transcripts are not stored locally" = SIGNAL.
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

${noUpdates}

## Output format
Write ONLY the following structure to: ${input.outputPath}
Use ONLY context dimensions that exist in context/ (${dims}). Three actions are allowed:
- "append" — new information that complements existing context
- "tension" — contradictions; always file: context/tensions.md
- "overwrite" — DO NOT USE in synthesis; reserved for /draft:compact only

---
input_source: granola
synthesized_by: ${input.intelligence}
timestamp: ${input.currentTimestamp}
profile: ${input.profile}
${meetingIdsOutput}context_updates:
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

export interface GranolaRunDeps extends IntelligenceDeps {
  fetchApi(token: string): Promise<unknown>;
}

export async function runGranolaSynthesis(context: GranolaContext, options: {
  workspace?: string; backgroundDir?: string; secretsPath?: string; now?: Date; deps?: GranolaRunDeps;
} = {}): Promise<string> {
  const deps = options.deps ?? { ...systemIntelligenceDeps, async fetchApi(token: string) {
    // This REST path is retained for parity with granola.sh and remains an
    // explicitly unverified future-mode contract; MCP is the default mode.
    const response = await fetch('https://api.granola.ai/v1/notes', { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Granola API returned ${response.status}`);
    return response.json();
  }};
  const profile = context.profile ?? 'default';
  const workspace = options.workspace ?? workspacePath(profile);
  const now = options.now ?? new Date();
  const mode = parseGranolaMode(context.mode);
  let transcriptContent: string | undefined;
  if (mode === 'api') {
    let secrets: Record<string, unknown> = {};
    try { secrets = JSON.parse(readFileSync(options.secretsPath ?? join(workspace, 'config', 'secrets.json'), 'utf8')); } catch {}
    const token = typeof secrets.granola_api_token === 'string' ? secrets.granola_api_token : '';
    if (!token) throw new Error('granola_api_token not found in config/secrets.json');
    const notes = filterApiMeetings(await deps.fetchApi(token), context.last_checked_at ?? null, now);
    if (!notes.length) return '';
    transcriptContent = formatApiMeetings(notes);
  }
  const tmp = join(workspace, 'tmp'); mkdirSync(tmp, { recursive: true });
  const outputPath = join(tmp, `granola-synthesis-${crypto.randomUUID()}`);
  const intelligence = process.env.DRAFT_GRANOLA_INTELLIGENCE ?? 'claude-code';
  try {
    return await runIntelligence({
      adapterPath: resolveIntelligenceAdapter(options.backgroundDir ?? defaultBackgroundDir(), intelligence, deps.exists),
      prompt: buildGranolaPrompt({ context: { ...context, mode }, workspace, profile, outputPath, currentTimestamp: now.toISOString().replace(/\.\d{3}Z$/, 'Z'), intelligence, transcriptContent }),
      outputPath,
    }, deps);
  } finally { rmSync(outputPath, { force: true }); }
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error('context file path required as argv[2]');
  runGranolaSynthesis(await Bun.file(path).json()).then(output => process.stdout.write(output)).catch(error => { process.stderr.write(`[granola.ts] ERROR: ${error.message}\n`); process.exit(1); });
}
