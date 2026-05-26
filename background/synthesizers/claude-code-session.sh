#!/bin/bash
# synthesizers/claude-code-session.sh — Session transcript source adapter
#
# Analyzes a Claude Code session transcript and produces a context update
# document for proposals/. Handles all session-specific logic:
# transcript reading, context-aware prompt building.
#
# See synthesizers/README.md for full contract.
#
# Usage: bash synthesizers/claude-code-session.sh <job_file>
#   job_file — JSON job written by on-session-end.sh

set -uo pipefail

JOB_FILE="$1"

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=../config.sh
source "$DRAFT_BACKGROUND/config.sh"

_log() {
    printf '[claude-code-session.sh] %s\n' "$*" >&2
}

# ── Read job fields ────────────────────────────────────────────────────────────
SESSION_ID=$(python3 -c "
import json, sys
d = json.load(open('$JOB_FILE'))
print(d.get('session_id', 'unknown'))
" 2>/dev/null || echo "unknown")

TRANSCRIPT_PATH=$(python3 -c "
import json, sys
d = json.load(open('$JOB_FILE'))
print(d.get('transcript_path', ''))
" 2>/dev/null || echo "")

JOB_TIMESTAMP=$(python3 -c "
import json, sys
d = json.load(open('$JOB_FILE'))
print(d.get('timestamp', ''))
" 2>/dev/null || echo "")

SESSION_SHORT="${SESSION_ID:0:8}"

# ── Validate transcript ────────────────────────────────────────────────────────
if [ -z "$TRANSCRIPT_PATH" ]; then
    _log "ERROR: transcript_path missing from job file"
    exit 1
fi

if [ ! -f "$TRANSCRIPT_PATH" ]; then
    _log "ERROR: transcript not found: $TRANSCRIPT_PATH"
    exit 1
fi

TRANSCRIPT_SIZE=$(wc -c < "$TRANSCRIPT_PATH" | tr -d ' ')
_log "transcript: $TRANSCRIPT_PATH ($TRANSCRIPT_SIZE bytes)"

# ── Create temp files ──────────────────────────────────────────────────────────
PROMPT_FILE=$(mktemp /tmp/draft-prompt-XXXXXX.txt)
mkdir -p "$DRAFT_WORKSPACE/tmp"
OUTPUT_FILE=$(mktemp "$DRAFT_WORKSPACE/tmp/synthesis-XXXXXX.md")

_cleanup() {
    rm -f "$PROMPT_FILE" "$OUTPUT_FILE"
}
trap _cleanup EXIT

# ── Build synthesis prompt ─────────────────────────────────────────────────────
CURRENT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Discover context files dynamically ─────────────────────────────────────────
# Enumerates all context/*/index.md files — not just the standard four.
# Teams may add custom dimensions (e.g. context/customers/, context/decisions/).
CONTEXT_FILES_LIST=$(find "${DRAFT_WORKSPACE}/context" -maxdepth 2 -name "index.md" 2>/dev/null | sort | sed 's/^/   - /')
CONTEXT_DIMS=$(find "${DRAFT_WORKSPACE}/context" -maxdepth 2 -name "index.md" 2>/dev/null | sort | while IFS= read -r f; do basename "$(dirname "$f")"; done | paste -sd ', ')
if [ -z "$CONTEXT_FILES_LIST" ]; then
    CONTEXT_FILES_LIST="   (no context files found — workspace may not be initialized)"
    CONTEXT_DIMS="(none found)"
fi

cat > "$PROMPT_FILE" <<PROMPT
# Draft Synthesis Task — Session Transcript

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## Session metadata
session_id: ${SESSION_ID}
profile: ${DRAFT_ACTIVE_PROFILE}
timestamp: ${JOB_TIMESTAMP}

## Files to read
1. Session transcript (full): ${TRANSCRIPT_PATH}
   This file may be large. Read it using your Read tool with offset/limit parameters if needed.
   Focus on: decisions made, product direction stated, blockers surfaced, feature scope changes.
   You do NOT need to read every line — scan for signal, then go deeper where relevant.
2. Existing workspace context (to know what's already captured):
${CONTEXT_FILES_LIST}
   - ${DRAFT_WORKSPACE}/context/tensions.md

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
Write ONLY the following structure to: ${OUTPUT_FILE}

Replace the bracketed sections with real content. Use ONLY files that exist in
context/ (${CONTEXT_DIMS}). Three actions are allowed:
- "append"   — new information that complements existing context (default for all synthesis)
- "tension"  — new info contradicts existing context; always set file: context/tensions.md
- "overwrite" — do NOT use in synthesis; reserved for curator-triggered compaction only

---
session_id: ${SESSION_ID}
input_source: session
synthesized_by: claude-code
timestamp: ${CURRENT_TS}
profile: ${DRAFT_ACTIVE_PROFILE}
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
- Write ONLY the document above to ${OUTPUT_FILE}. No preamble. No commentary.
- After writing the file, type /exit to end the session.
PROMPT

_log "prompt written ($( wc -c < "$PROMPT_FILE" ) bytes), calling intelligence adapter"

# ── Call intelligence adapter ──────────────────────────────────────────────────
INTELLIGENCE="${DRAFT_SESSION_INTELLIGENCE:-claude-code}"
INTELLIGENCE_SCRIPT="$DRAFT_BACKGROUND/intelligence/${INTELLIGENCE}.sh"

if [ ! -x "$INTELLIGENCE_SCRIPT" ]; then
    _log "ERROR: intelligence adapter not found or not executable: $INTELLIGENCE_SCRIPT"
    exit 1
fi

bash "$INTELLIGENCE_SCRIPT" "$PROMPT_FILE" "$OUTPUT_FILE"
INTEL_EXIT=$?

if [ $INTEL_EXIT -ne 0 ]; then
    _log "ERROR: intelligence adapter exited $INTEL_EXIT"
    exit 1
fi

# ── Validate and output ────────────────────────────────────────────────────────
if [ ! -f "$OUTPUT_FILE" ] || [ ! -s "$OUTPUT_FILE" ]; then
    _log "ERROR: intelligence adapter returned success but output_file is empty or missing"
    exit 1
fi

# Basic frontmatter validation — must start with ---
FIRST_LINE=$(head -1 "$OUTPUT_FILE")
if [ "$FIRST_LINE" != "---" ]; then
    _log "WARN: output does not start with YAML frontmatter (---) — passing through anyway"
fi

_log "synthesis complete ($(wc -c < "$OUTPUT_FILE") bytes)"

# Output to stdout — synthesize.sh writes this to proposals/
cat "$OUTPUT_FILE"
exit 0
