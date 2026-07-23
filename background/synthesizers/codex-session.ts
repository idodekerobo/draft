// background/synthesizers/codex-session.ts — Codex session source adapter
//
// Reads a Codex session transcript (JSONL), builds a synthesis prompt,
// calls the configured intelligence adapter, and prints the YAML result
// to stdout for synthesize.ts to stage as a proposal.
//
// Codex JSONL schema (confirmed from real session files):
//   { type: "session_meta",  payload: { session_id, cwd, ... } }
//   { type: "event_msg",     payload: { type: "user_message", message: "..." } }
//   { type: "response_item", payload: { role: "assistant", content: [{ type: "output_text", text: "..." }] } }
//   { type: "event_msg",     payload: { type: "turn_complete", ... } }
//
// Contract (same as all source adapters):
//   process.argv[2] = job file path
//   stdout = YAML frontmatter + synthesis preview
//   Exit 0 on success, 1 on failure

import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join, basename, dirname } from 'path';
import { BACKGROUND_DIR, DRAFT_ROOT, getWorkspacePath } from 'draft-core/config';
import { resolveRuntimeEntrypoint, runtimeCommand } from 'draft-core/runtime';

function log(msg: string) {
  process.stderr.write(`[codex-session.ts] ${msg}\n`);
}

// ── Parse job ──────────────────────────────────────────────────────────────────

const jobPath = process.argv[2];
if (!jobPath) {
  log('ERROR: job file path required as argv[2]');
  process.exit(1);
}

let job: Record<string, string>;
try {
  job = JSON.parse(await Bun.file(jobPath).text());
} catch {
  log(`ERROR: could not parse job file: ${jobPath}`);
  process.exit(1);
}

const sessionId     = job.session_id     ?? 'unknown';
const transcriptPath = job.transcript_path ?? '';
const profile       = job.profile        ?? 'default';
const cwd           = job.cwd            ?? '';
const jobTimestamp  = job.timestamp      ?? '';
const sessionShort  = sessionId.slice(0, 8);

// ── Validate transcript ────────────────────────────────────────────────────────

if (!transcriptPath || !existsSync(transcriptPath)) {
  log(`ERROR: transcript not found: ${transcriptPath}`);
  process.exit(1);
}

const transcriptSize = Bun.file(transcriptPath).size;
log(`transcript: ${transcriptPath} (${transcriptSize} bytes)`);

// ── Parse Codex JSONL transcript ───────────────────────────────────────────────

interface CodexLine {
  type: string;
  payload: Record<string, unknown>;
}

interface ContentItem {
  type: string;
  text?: string;
}

const rawLines = (await Bun.file(transcriptPath).text()).split('\n').filter(Boolean);
const conversationParts: string[] = [];

for (const raw of rawLines) {
  let line: CodexLine;
  try { line = JSON.parse(raw); } catch { continue; }

  const { type, payload } = line;
  if (!payload) continue;

  if (type === 'event_msg' && payload.type === 'user_message') {
    const msg = (payload.message as string | undefined)?.trim();
    if (msg) conversationParts.push(`User: ${msg}`);
  }

  if (type === 'response_item' && payload.role === 'assistant') {
    const content = payload.content as ContentItem[] | undefined;
    if (Array.isArray(content)) {
      const text = content
        .filter(c => c.type === 'output_text' && c.text)
        .map(c => c.text!.trim())
        .join('\n')
        .trim();
      if (text) conversationParts.push(`Assistant: ${text}`);
    }
  }
}

if (conversationParts.length === 0) {
  log('WARN: no conversation content found in transcript — nothing to synthesize');
  // Exit 0 with empty output; synthesize.ts treats empty stdout as "no updates"
  process.exit(0);
}

const conversationText = conversationParts.join('\n\n');
log(`parsed ${conversationParts.length} conversation parts`);

// ── Workspace + context ────────────────────────────────────────────────────────

const workspace    = getWorkspacePath(profile);
const contextDir   = join(workspace, 'context');
const tensionsPath = join(workspace, 'context', 'tensions.md');
const tmpDir       = join(workspace, 'tmp');

mkdirSync(tmpDir, { recursive: true });

// Discover all context dimension index files dynamically
const contextFiles: string[] = [];
const contextDims: string[]  = [];

try {
  for (const entry of readdirSync(contextDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const indexPath = join(contextDir, entry.name, 'index.md');
    if (existsSync(indexPath)) {
      contextFiles.push(indexPath);
      contextDims.push(entry.name);
    }
  }
  contextFiles.sort();
  contextDims.sort();
} catch {
  // context/ doesn't exist yet — workspace may not be initialized
}

const contextFilesList = contextFiles.length > 0
  ? contextFiles.map(f => `   - ${f}`).join('\n')
  : '   (no context files found — workspace may not be initialized)';
const contextDimsStr = contextDims.length > 0 ? contextDims.join(',') : '(none found)';

// ── Build synthesis prompt ─────────────────────────────────────────────────────

const promptFile = join(tmpDir, `codex-prompt-${sessionShort}-${Date.now()}`);
const outputFile = join(tmpDir, `codex-output-${sessionShort}-${Date.now()}`);
const currentTs  = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const prompt = `# Draft Synthesis Task — Codex Session Transcript

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## Session metadata
session_id: ${sessionId}
profile: ${profile}
timestamp: ${jobTimestamp}
cwd: ${cwd}

## Conversation transcript
The following is the Codex session conversation to analyze:

${conversationText}

## Files to read
1. Existing workspace context (to know what's already captured):
${contextFilesList}
   - ${tensionsPath}

Read these files before writing your synthesis. Reading tensions.md tells you what
contradictions are already flagged — do not create duplicate tension entries.

## Your task
Analyze the session conversation. Extract only what would help a teammate
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
Write ONLY the following structure to: ${outputFile}

Replace the bracketed sections with real content. Use ONLY files that exist in
context/ (${contextDimsStr}). Three actions are allowed:
- "append"   — new information that complements existing context (default for all synthesis)
- "tension"  — new info contradicts existing context; always set file: context/tensions.md
- "overwrite" — do NOT use in synthesis; reserved for curator-triggered compaction only

---
session_id: ${sessionId}
input_source: session
synthesized_by: ${process.env.DRAFT_SESSION_INTELLIGENCE ?? 'claude-code'}
timestamp: ${currentTs}
profile: ${profile}
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
- Do NOT copy raw conversation excerpts. Write synthesized insights only.
- Do NOT invent information not present in the conversation.
- For contradictions: ALWAYS use action: tension with file: context/tensions.md. Never overwrite to resolve a contradiction — that is the curator's decision, not the synthesizer's.
- Write ONLY the document above to ${outputFile}. No preamble. No commentary.
- After writing the file, type /exit to end the session.
`;

await Bun.write(promptFile, prompt);
log(`prompt written (${prompt.length} bytes), calling intelligence adapter`);

// ── Call intelligence adapter ──────────────────────────────────────────────────

const intelligence = process.env.DRAFT_SESSION_INTELLIGENCE ?? 'claude-code';
if (!/^[a-zA-Z0-9_-]+$/.test(intelligence)) {
  log('ERROR: invalid intelligence adapter name');
  process.exit(1);
}
const adapter = resolveRuntimeEntrypoint(join(BACKGROUND_DIR, 'intelligence', intelligence));
const adapterCmd = adapter && runtimeCommand(adapter, [promptFile, outputFile]);
if (!adapterCmd) {
  log(`ERROR: intelligence adapter not found for "${intelligence}" (tried .js, .ts, and .sh)`);
  try { unlinkSync(promptFile); } catch {}
  process.exit(1);
}

const adapterProc = Bun.spawn(adapterCmd, {
  stdin:  'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
});

const adapterExit = await adapterProc.exited;

try { unlinkSync(promptFile); } catch {}

if (adapterExit !== 0) {
  log(`ERROR: intelligence adapter exited ${adapterExit}`);
  try { unlinkSync(outputFile); } catch {}
  process.exit(1);
}

// ── Validate and output ────────────────────────────────────────────────────────

if (!existsSync(outputFile)) {
  log('ERROR: intelligence adapter returned success but output file is missing');
  process.exit(1);
}

const outputText = await Bun.file(outputFile).text();
try { unlinkSync(outputFile); } catch {}

if (!outputText.trim()) {
  log('ERROR: intelligence adapter returned success but output file is empty');
  process.exit(1);
}

const firstLine = outputText.split('\n')[0]?.trim();
if (firstLine !== '---') {
  log('WARN: output does not start with YAML frontmatter (---) — passing through anyway');
}

log(`synthesis complete (${outputText.length} bytes)`);

// Print to stdout — synthesize.ts captures this and writes to proposals/
process.stdout.write(outputText);
process.exit(0);
