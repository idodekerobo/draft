#!/bin/bash
# synthesizers/slack.sh — Slack message batch source adapter
#
# Receives a context JSON file with paths to reconstructed channel markdown files.
# Reads reconstructed content + current workspace context inline into the prompt.
# Calls the intelligence adapter (default: claude-code).
# Outputs: YAML frontmatter proposal to stdout (for writing to proposals/).
#
# See synthesizers/README.md for full contract.
#
# Usage: bash synthesizers/slack.sh <context_file>
#   context_file — JSON written by slack-analyzer.sh

set -uo pipefail

CONTEXT_FILE="$1"

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=../config.sh
source "$DRAFT_BACKGROUND/config.sh"

_log() {
    printf '[slack.sh] %s\n' "$*" >&2
}

# Extract the description field from a context index file's YAML frontmatter
extract_description() {
    local file="$1"
    python3 - "$file" <<'PYEOF'
import sys, re

try:
    content = open(sys.argv[1]).read()
    match = re.search(r'^---\n(.*?)\n---', content, re.DOTALL)
    if match:
        fm = match.group(1)
        # Handle block scalar: "description: >\n  indented text"
        desc = re.search(r'description:\s*>\s*\n((?:[ \t]+.+\n?)+)', fm)
        if desc:
            lines = [l.strip() for l in desc.group(1).splitlines()]
            print(' '.join(lines).strip())
        else:
            desc = re.search(r'description:\s*(.+)', fm)
            if desc:
                print(desc.group(1).strip())
except Exception:
    pass
PYEOF
}

# ── Read context fields ────────────────────────────────────────────────────────

PROFILE=$(python3 -c "
import json
d = json.load(open('$CONTEXT_FILE'))
print(d.get('profile', 'default'))
" 2>/dev/null || echo "default")

ANALYSIS_WINDOW=$(python3 -c "
import json
d = json.load(open('$CONTEXT_FILE'))
print(d.get('analysis_window_hours', 8))
" 2>/dev/null || echo "8")

CURRENT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Collect reconstructed files ────────────────────────────────────────────────

RECONSTRUCTED_FILES=$(python3 -c "
import json
d = json.load(open('$CONTEXT_FILE'))
files = d.get('reconstructed_files', [])
print('\n'.join(files))
" 2>/dev/null || echo "")

if [ -z "$RECONSTRUCTED_FILES" ]; then
    _log "ERROR: no reconstructed_files in context"
    exit 1
fi

# ── Discover context files dynamically ────────────────────────────────────────

CONTEXT_FILES_LIST=$(find "${DRAFT_WORKSPACE}/context" -maxdepth 2 -name "index.md" 2>/dev/null | sort | sed 's/^/   - /')
CONTEXT_DIMS=$(find "${DRAFT_WORKSPACE}/context" -maxdepth 2 -name "index.md" 2>/dev/null | sort | while IFS= read -r f; do basename "$(dirname "$f")"; done | paste -sd ',')
if [ -z "$CONTEXT_FILES_LIST" ]; then
    CONTEXT_FILES_LIST="   (no context files found)"
    CONTEXT_DIMS="(none found)"
fi

# ── Build channel file list for prompt ──────────────────────────────────────

CHANNEL_FILE_LIST=""
while IFS= read -r rfile; do
    [ -z "$rfile" ] && continue
    [ ! -f "$rfile" ] && continue
    CHANNEL_NAME=$(basename "$(dirname "$rfile")")
    CHANNEL_FILE_LIST="${CHANNEL_FILE_LIST}- #${CHANNEL_NAME}: ${rfile}
"
done <<< "$RECONSTRUCTED_FILES"

# ── Build context dimension summaries ──────────────────────────────────

CONTEXT_DIMS_CONTENT=""
while IFS= read -r INDEX_FILE; do
    dim=$(basename "$(dirname "$INDEX_FILE")")
    if [ -f "$INDEX_FILE" ]; then
        DESC=$(extract_description "$INDEX_FILE")
        CONTEXT_DIMS_CONTENT="${CONTEXT_DIMS_CONTENT}
### ${dim}
${DESC}
Full file (read if needed): ${INDEX_FILE}
"
    fi
done < <(find "$DRAFT_WORKSPACE/context" -maxdepth 2 -name "index.md" | sort)

# ── Read tensions.md ─────────────────────────────────────────────────────────

TENSIONS_FILE="${DRAFT_WORKSPACE}/context/tensions.md"
if [ -f "$TENSIONS_FILE" ]; then
    TENSIONS_CONTENT=$(cat "$TENSIONS_FILE")
else
    TENSIONS_CONTENT="(no tensions file found)"
fi

# ── Read roles ─────────────────────────────────────────────────────────────────

ROLES_FILE="${DRAFT_WORKSPACE}/config/slack-roles.json"
ROLES_CONTENT=""
if [ -f "$ROLES_FILE" ]; then
    ROLES_CONTENT=$(python3 -c "
import json
d = json.load(open('$ROLES_FILE'))
lines = []
for uid, info in d.items():
    if uid.startswith('__'): continue
    name = info.get('name', uid)
    role = info.get('role', 'team member')
    lines.append(f'  {name} ({role})')
print('\n'.join(lines))
" 2>/dev/null || echo "  (no roles configured)")
fi

# ── Read pending proposals ────────────────────────────────────────────────────
# Inject unreviewed proposals so the LLM can skip already-captured content
# or overwrite a proposal if recent messages update the picture.

PROPOSALS_CONTENT=""
PROPOSALS_DIR="${DRAFT_WORKSPACE}/proposals"
MAX_PER_PROPOSAL=3000

if [ -d "$PROPOSALS_DIR" ]; then
    while IFS= read -r pfile; do
        [ -z "$pfile" ] && continue
        PNAME=$(basename "$pfile")
        PCONTENT=$(head -c "$MAX_PER_PROPOSAL" "$pfile" 2>/dev/null || echo "(unreadable)")
        PROPOSALS_CONTENT="${PROPOSALS_CONTENT}
### ${PNAME}
${PCONTENT}
"
    done < <(find "$PROPOSALS_DIR" -maxdepth 1 -name "*.md" 2>/dev/null | sort)
fi

if [ -z "$PROPOSALS_CONTENT" ]; then
    PROPOSALS_CONTENT="(none)"
fi

# Derive last synthesis timestamp from the most recent proposal's frontmatter.
# This tells the LLM how long ago it last ran, so it can reason about the gap.
LAST_SYNTHESIS_TS="(no prior synthesis)"
if [ -d "$PROPOSALS_DIR" ]; then
    _latest_proposal=$(find "$PROPOSALS_DIR" -maxdepth 1 -name "*.md" 2>/dev/null | sort | tail -1)
    if [ -n "$_latest_proposal" ]; then
        _ts=$(python3 -c "
import re, sys
try:
    content = open('$_latest_proposal').read()
    m = re.search(r'^---\n(.+?)\n---', content, re.DOTALL)
    if m:
        t = re.search(r'^timestamp:\s*(\S+)', m.group(1), re.MULTILINE)
        if t:
            print(t.group(1))
            sys.exit(0)
except Exception:
    pass
print('')
" 2>/dev/null || echo "")
        if [ -n "$_ts" ]; then
            LAST_SYNTHESIS_TS="$_ts"
        fi
    fi
fi

# ── Create temp files ─────────────────────────────────────────────────────────

PROMPT_FILE=$(mktemp /tmp/draft-slack-prompt-XXXXXX)
OUTPUT_FILE=$(mktemp /tmp/draft-slack-synthesis-XXXXXX)

_cleanup() {
    rm -f "$PROMPT_FILE" "$OUTPUT_FILE"
}
trap _cleanup EXIT

# ── Write synthesis prompt ─────────────────────────────────────────────────────

cat > "$PROMPT_FILE" <<PROMPT
# Draft Synthesis Task — Slack Messages

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## Analysis period
Last ${ANALYSIS_WINDOW} hours of Slack activity.
Current time: ${CURRENT_TS}
Last synthesis: ${LAST_SYNTHESIS_TS}
Profile: ${PROFILE}

## Team roles
Use these roles to weight messages (founder/lead decisions carry more weight):
${ROLES_CONTENT}

## Slack channel files
Each file contains today's messages for one channel, chronological with threads nested.
Read each file using your Read tool. Use offset/limit on large files.
Focus on messages containing decisions, blockers, shipped work, or open questions.

${CHANNEL_FILE_LIST}

## Workspace context
Current state summaries — read the full file at the listed path only if the summary is insufficient.
${CONTEXT_DIMS_CONTENT}

## Active tensions
${TENSIONS_CONTENT}

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

${PROPOSALS_CONTENT}

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
- "append"   — new info that complements existing context (default)
- "tension"  — contradiction with existing context; always file: context/tensions.md
- "overwrite" — DO NOT USE in context_updates

The optional top-level field replaces_proposal names an existing proposal file to
overwrite rather than creating a new one. Omit it when creating a fresh proposal.

---
replaces_proposal: 20260522T004806Z-slack.md   # optional — omit if creating new
input_source: slack
synthesized_by: ${DRAFT_SLACK_INTELLIGENCE:-claude-code}
timestamp: ${CURRENT_TS}
profile: ${PROFILE}
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
PROMPT

_log "prompt written ($(wc -c < "$PROMPT_FILE") bytes), calling intelligence adapter"

# ── Call intelligence adapter ─────────────────────────────────────────────────

INTELLIGENCE="${DRAFT_SLACK_INTELLIGENCE:-claude-code}"
INTELLIGENCE_SCRIPT="$DRAFT_BACKGROUND/intelligence/${INTELLIGENCE}.sh"

if [ ! -x "$INTELLIGENCE_SCRIPT" ]; then
    _log "ERROR: intelligence adapter not found: $INTELLIGENCE_SCRIPT"
    exit 1
fi

bash "$INTELLIGENCE_SCRIPT" "$PROMPT_FILE" "$OUTPUT_FILE"
INTEL_EXIT=$?

if [ $INTEL_EXIT -ne 0 ]; then
    _log "ERROR: intelligence adapter exited $INTEL_EXIT"
    exit 1
fi

if [ ! -f "$OUTPUT_FILE" ] || [ ! -s "$OUTPUT_FILE" ]; then
    _log "ERROR: intelligence adapter returned empty output"
    exit 1
fi

FIRST_LINE=$(head -1 "$OUTPUT_FILE")
if [ "$FIRST_LINE" != "---" ]; then
    _log "WARN: output does not start with YAML frontmatter (---) — passing through anyway"
fi

_log "synthesis complete ($(wc -c < "$OUTPUT_FILE") bytes)"
cat "$OUTPUT_FILE"
exit 0
