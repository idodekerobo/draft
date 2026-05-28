#!/bin/bash
# synthesizers/granola.sh — Granola meeting transcript source adapter
#
# Synthesizes Granola meeting transcripts into context update proposals.
# Called by granola-poller.sh with a context JSON file (not a session job file).
#
# Two modes, selected by DRAFT_GRANOLA_MODE (set in config.sh):
#
#   mcp (default) — Constructs a prompt instructing Claude Code to use its
#     connected Granola MCP tools (list_meetings, get_meeting_transcript) to
#     fetch and synthesize new meetings in a single agent call. Claude handles
#     both data fetching and synthesis — no bash REST plumbing needed.
#     Requires: Granola MCP configured in ~/.claude/settings.json
#
#   api — Fetches transcripts via Granola REST API (curl), passes content as
#     text to the intelligence adapter. Claude synthesizes only — no MCP needed.
#     Requires: granola_api_token in config/secrets.json
#     Note: api mode is a future optimization path (Phase 2+). The MCP path
#     is simpler when using claude-code intelligence and is the default.
#
# Context file schema (from granola-poller.sh):
#   { type, mode, profile, timestamp, last_checked_at, state_file }
#
# Output contract (same as claude-code-session.sh — see synthesizers/README.md):
#   stdout → YAML frontmatter .md written to proposals/ by granola-poller.sh
#   stderr → log lines
#   exit 0 → success (including "no updates" case — poller handles empty output)
#   exit 1 → failure → poller logs error, does not update state
#
# See synthesizers/README.md for full adapter contract.

set -uo pipefail

CONTEXT_FILE="$1"

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=../config.sh
source "$DRAFT_BACKGROUND/config.sh"

_log() {
    printf '[granola.sh] %s\n' "$*" >&2
}

# ── Read context fields ────────────────────────────────────────────────────────
PROFILE=$(python3 -c "
import json
d = json.load(open('$CONTEXT_FILE'))
print(d.get('profile', 'default'))
" 2>/dev/null || echo "default")

LAST_CHECKED_AT=$(python3 -c "
import json
d = json.load(open('$CONTEXT_FILE'))
v = d.get('last_checked_at')
print(v if v else '')
" 2>/dev/null || echo "")

# Formatted as a bullet list for prompt injection; empty string if none
PROCESSED_IDS_LIST=$(python3 -c "
import json
d = json.load(open('$CONTEXT_FILE'))
ids = d.get('processed_meeting_ids', [])
if ids:
    print('\n'.join(f'  - {i}' for i in ids))
" 2>/dev/null || echo "")

MODE=$(python3 -c "
import json
d = json.load(open('$CONTEXT_FILE'))
print(d.get('mode', 'mcp'))
" 2>/dev/null || echo "mcp")

CURRENT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Resolve intelligence adapter ───────────────────────────────────────────────
INTELLIGENCE="${DRAFT_GRANOLA_INTELLIGENCE:-claude-code}"
INTELLIGENCE_SCRIPT="$DRAFT_BACKGROUND/intelligence/${INTELLIGENCE}.sh"

if [ ! -x "$INTELLIGENCE_SCRIPT" ]; then
    _log "ERROR: intelligence adapter not found: $INTELLIGENCE_SCRIPT"
    exit 1
fi

# ── Dynamically discover context files ────────────────────────────────────────
WORKSPACE="$HOME/.draft/workspaces/${PROFILE}"
CONTEXT_FILES_LIST=$(find "$WORKSPACE/context" -maxdepth 2 -name "index.md" 2>/dev/null | sort | \
    while read -r f; do printf '   - %s\n' "$f"; done)
CONTEXT_DIMS=$(find "$WORKSPACE/context" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | sort | \
    xargs -I{} basename {} | tr '\n' ',' | sed 's/,$//')

if [ -z "$CONTEXT_FILES_LIST" ]; then
    _log "WARN: no context files found in $WORKSPACE/context — synthesis will proceed without existing context"
    CONTEXT_FILES_LIST="   (none found)"
fi

# ── Build prompt + call intelligence ──────────────────────────────────────────
PROMPT_FILE=$(mktemp /tmp/draft-granola-prompt-XXXXXX.txt)
# Output file must live inside the workspace — Claude Code's Write tool restricts
# writes to paths within the CWD (~/.draft/workspaces/<profile>/) even with
# --dangerously-skip-permissions. /tmp/ is outside that boundary.
mkdir -p "$DRAFT_WORKSPACE/tmp"
OUTPUT_FILE=$(mktemp "$DRAFT_WORKSPACE/tmp/granola-synthesis-XXXXXX")

_cleanup() { rm -f "$PROMPT_FILE" "$OUTPUT_FILE"; }
trap _cleanup EXIT

case "$MODE" in

    # ── MCP mode ──────────────────────────────────────────────────────────────
    # Claude Code uses its connected Granola MCP tools to fetch meetings and
    # synthesize transcripts in a single agent call. No bash REST plumbing.
    mcp)
        _log "mode=mcp intelligence=${INTELLIGENCE}"

        SINCE_TEXT=""
        if [ -n "$LAST_CHECKED_AT" ]; then
            SINCE_TEXT="Since your last check: ${LAST_CHECKED_AT}"
        else
            SINCE_TEXT="No previous check recorded — look back 24 hours."
        fi

        cat > "$PROMPT_FILE" <<PROMPT
# Draft Synthesis Task — Granola Meeting Transcripts

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## State
profile: ${PROFILE}
timestamp: ${CURRENT_TS}
${SINCE_TEXT}

## Existing workspace context
Read these files before synthesizing so you know what's already captured:
${CONTEXT_FILES_LIST}

Also read context/tensions.md if it exists — do not add content that contradicts existing context without routing it as a tension.

## Your task

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
${PROCESSED_IDS_LIST:-  (none — first run)}

**Step 1 — Fetch meetings via Granola MCP**
1. Call \`list_meetings\` to find recent meetings (use time_range "this_week" or "today").
2. For each meeting returned:
   - Skip if its ID is in the already-processed list above
   - Skip any meeting that ended less than 30 minutes ago (transcript may be incomplete)
   - Call \`get_meetings\` with the meeting ID to fetch full content including notes
   - If you need verbatim quotes or more granular detail, also call \`get_meeting_transcript\`

**Step 2 — Synthesize context updates**
For each fetched transcript, extract only what would help a teammate start their
next AI session with better shared context.

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

**If no new meetings, or no team-relevant content:** write the document with
empty context_updates: [].

## Output format

Write ONLY the following structure to: ${OUTPUT_FILE}

Use ONLY context dimensions that exist in context/ (${CONTEXT_DIMS}).
Three actions are allowed:
- "append"    — new information that complements existing context (default for all synthesis)
- "tension"   — new info contradicts existing context; always set file: context/tensions.md
- "overwrite" — DO NOT USE in synthesis; reserved for /draft:compact only

---
input_source: granola
synthesized_by: ${INTELLIGENCE}
timestamp: ${CURRENT_TS}
profile: ${PROFILE}
meeting_ids:
  - [id of each meeting you synthesized — from the meeting ID returned by list_meetings/get_meetings]
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
- Write ONLY the document above to ${OUTPUT_FILE}. No preamble. No commentary.
- After writing the file, type /exit to end the session.
PROMPT

        _log "prompt written ($(wc -c < "$PROMPT_FILE") bytes), calling ${INTELLIGENCE}"
        bash "$INTELLIGENCE_SCRIPT" "$PROMPT_FILE" "$OUTPUT_FILE"
        INTEL_EXIT=$?
        ;;

    # ── API mode ──────────────────────────────────────────────────────────────
    # Daemon fetches transcripts via Granola REST API (curl).
    # Passes transcript content as text to the intelligence adapter.
    # This path is for future use when switching to a stateless intelligence
    # adapter (e.g. claude-api) for speed/cost optimization.
    api)
        _log "mode=api intelligence=${INTELLIGENCE}"

        # Read API token from secrets.json
        GRANOLA_TOKEN=$(python3 -c "
import json, sys
d = json.load(open('$DRAFT_SECRETS'))
t = d.get('granola_api_token', '')
if not t:
    sys.exit(1)
print(t)
" 2>/dev/null || echo "")

        if [ -z "$GRANOLA_TOKEN" ]; then
            _log "ERROR: granola_api_token not found in config/secrets.json"
            exit 1
        fi

        # Fetch recent meetings from Granola REST API
        # API docs: https://granola.ai/api (personal/enterprise token auth)
        # Endpoint: GET /v1/notes (or equivalent — verify against current Granola API docs)
        # Filter: only meetings newer than last_checked_at, older than 30 min
        THIRTY_MIN_AGO=$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
                         date -u -d "30 minutes ago" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || \
                         echo "")

        MEETINGS_RESPONSE=$(curl -s -f \
            -H "Authorization: Bearer ${GRANOLA_TOKEN}" \
            -H "Content-Type: application/json" \
            "https://api.granola.ai/v1/notes" 2>/dev/null || echo "")

        if [ -z "$MEETINGS_RESPONSE" ]; then
            _log "WARN: Granola API returned empty response — check token and API endpoint"
            # Exit 0 so poller still updates last_checked_at
            exit 0
        fi

        # Filter and format transcript content for synthesis
        TRANSCRIPT_CONTENT=$(python3 - <<PYEOF
import json, sys
from datetime import datetime, timezone, timedelta

response_str = '''$MEETINGS_RESPONSE'''
last_checked = "$LAST_CHECKED_AT"
thirty_min_ago_str = "$THIRTY_MIN_AGO"

try:
    data = json.loads(response_str)
except Exception as e:
    print(f"Error parsing API response: {e}", file=sys.stderr)
    sys.exit(1)

# Normalize: Granola API may return {"notes": [...]} or a list directly
notes = data if isinstance(data, list) else data.get("notes", data.get("data", []))

cutoff = None
if last_checked:
    try:
        cutoff = datetime.fromisoformat(last_checked.replace("Z", "+00:00"))
    except Exception:
        pass

thirty_min_cutoff = None
if thirty_min_ago_str:
    try:
        thirty_min_cutoff = datetime.fromisoformat(thirty_min_ago_str.replace("Z", "+00:00"))
    except Exception:
        pass

output_parts = []
for note in notes:
    # Skip notes without a transcript
    transcript = note.get("transcript") or note.get("content") or ""
    if not transcript:
        continue

    # Time-based filtering
    created_at_str = note.get("created_at") or note.get("createdAt") or ""
    if created_at_str:
        try:
            created_at = datetime.fromisoformat(created_at_str.replace("Z", "+00:00"))
            # Skip if newer than 30 min ago (partial transcript risk)
            if thirty_min_cutoff and created_at > thirty_min_cutoff:
                continue
            # Skip if older than last check
            if cutoff and created_at <= cutoff:
                continue
        except Exception:
            pass

    title = note.get("title") or note.get("name") or "Untitled meeting"
    output_parts.append(f"=== {title} ===\n{transcript}\n")

if not output_parts:
    print("NO_NEW_MEETINGS")
else:
    print("\n".join(output_parts))
PYEOF
)

        if [ "$TRANSCRIPT_CONTENT" = "NO_NEW_MEETINGS" ] || [ -z "$TRANSCRIPT_CONTENT" ]; then
            _log "info" "no new meetings since ${LAST_CHECKED_AT:-start}"
            exit 0
        fi

        # Build synthesis prompt with transcript content embedded
        cat > "$PROMPT_FILE" <<PROMPT
# Draft Synthesis Task — Granola Meeting Transcripts

You are a context synthesis agent for Draft, a shared team context layer for AI sessions.

## State
profile: ${PROFILE}
timestamp: ${CURRENT_TS}
last_checked_at: ${LAST_CHECKED_AT:-never}

## Existing workspace context
Read these files before synthesizing so you know what's already captured:
${CONTEXT_FILES_LIST}
   - ${DRAFT_WORKSPACE}/context/tensions.md

Read tensions.md before synthesizing — do not add content that contradicts existing context
without routing it as a tension. Do not create duplicate tension entries.

## Meeting transcripts to synthesize

${TRANSCRIPT_CONTENT}

## Your task
Extract only what would help a teammate start their next AI session with better
shared context.

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

**If no team-relevant content:** write the document with empty context_updates: [].

## Output format
Write ONLY to: ${OUTPUT_FILE}

Use ONLY context dimensions that exist in context/ (${CONTEXT_DIMS}).
Three actions are allowed:
- "append"    — new information that complements existing context (default for all synthesis)
- "tension"   — new info contradicts existing context; always set file: context/tensions.md
- "overwrite" — DO NOT USE in synthesis; reserved for /draft:compact only

---
input_source: granola
synthesized_by: ${INTELLIGENCE}
timestamp: ${CURRENT_TS}
profile: ${PROFILE}
context_updates:
  - file: context/product/index.md
    action: append
    content: |
      [specific synthesized insight]
---

## Synthesis preview
### context/product/index.md — append
[same content]

## STRICT RULES
- Do NOT ask questions. Do NOT seek clarification. If ambiguous, omit.
- Do NOT copy raw transcript text. Write synthesized insights only.
- Do NOT invent information not present in the transcripts.
- For contradictions: ALWAYS use action: tension with file: context/tensions.md. Never overwrite to resolve a contradiction — that is the curator's decision, not the synthesizer's.
- Write ONLY the document above to ${OUTPUT_FILE}. No preamble. No commentary.
- After writing the file, type /exit to end the session.
PROMPT

        _log "prompt written ($(wc -c < "$PROMPT_FILE") bytes transcript=$(echo "$TRANSCRIPT_CONTENT" | wc -c) bytes), calling ${INTELLIGENCE}"
        bash "$INTELLIGENCE_SCRIPT" "$PROMPT_FILE" "$OUTPUT_FILE"
        INTEL_EXIT=$?
        ;;

    *)
        _log "ERROR: unknown mode '${MODE}' — expected 'mcp' or 'api'"
        exit 1
        ;;
esac

# ── Validate intelligence output ───────────────────────────────────────────────
if [ "${INTEL_EXIT:-1}" -ne 0 ]; then
    _log "ERROR: intelligence adapter exited ${INTEL_EXIT}"
    exit 1
fi

if [ ! -f "$OUTPUT_FILE" ] || [ ! -s "$OUTPUT_FILE" ]; then
    _log "ERROR: intelligence adapter returned success but output file is empty or missing"
    exit 1
fi

FIRST_LINE=$(head -1 "$OUTPUT_FILE")
if [ "$FIRST_LINE" != "---" ]; then
    _log "WARN: output does not start with YAML frontmatter (---) — passing through anyway"
fi

_log "synthesis complete ($(wc -c < "$OUTPUT_FILE") bytes)"

# Output to stdout — granola-poller.sh writes this to proposals/
cat "$OUTPUT_FILE"
exit 0
