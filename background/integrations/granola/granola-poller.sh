#!/bin/bash
# granola-poller.sh — Draft Granola transcript poller
#
# Called by draft-daemon.sh on DRAFT_GRANOLA_POLL interval (async, non-blocking).
# Checks for new Granola meetings, synthesizes transcripts into context proposals.
#
# This poller is the orchestrator for the Granola pipeline. It:
#   1. Reads runtime state from background/state/granola.json
#   2. Routes to synthesizers/granola.sh based on DRAFT_GRANOLA_MODE
#   3. Writes synthesis output directly to proposals/ (not via pending/ queue)
#   4. Updates state on successful run
#
# Two modes (set via DRAFT_GRANOLA_MODE in config.sh):
#   mcp  — Claude Code uses connected Granola MCP tools to fetch + synthesize.
#          No REST token needed. Requires Granola MCP registered via `claude mcp add`.
#          Verified at runtime via `claude mcp list`. Recommended when DRAFT_GRANOLA_INTELLIGENCE=claude-code.
#
#   api  — Daemon fetches transcripts via Granola REST API (curl).
#          Requires granola_api_token in config/secrets.json.
#          Better fit when using a stateless intelligence adapter (claude-api).
#
# State file: background/state/granola.json
#   { "last_checked_at": "<ISO>", "processed_meeting_ids": ["id1", ...] }
#   Delete this file to reset the poller (re-scans from scratch on next run).
#
# Onboarding: /draft:connect granola (Claude Code slash command)
#   Guides user through MCP or API setup, writes to config/secrets.json
#   and/or ~/.claude/settings.json. Sets DRAFT_GRANOLA_MODE accordingly.
#
# Future (TypeScript rewrite, Phase 4+):
#   GranolaPoller class — same two modes, shared types with Electron desktop app.

set -uo pipefail

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=config.sh
source "$DRAFT_BACKGROUND/config.sh"

STATE_FILE="$DRAFT_BACKGROUND/state/granola.json"
SYNTHESIZER="$DRAFT_BACKGROUND/synthesizers/granola.sh"

_log() {
    local level="$1" msg="$2"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"ts":"%s","level":"%s","component":"granola-poller","msg":"%s"}\n' \
        "$ts" "$level" "$msg"
}

# ── Preflight checks ───────────────────────────────────────────────────────────

if [ ! -x "$SYNTHESIZER" ]; then
    _log "warn" "synthesizers/granola.sh not found or not executable — skipping poll"
    exit 0
fi

# ── Read state ─────────────────────────────────────────────────────────────────
# Ensure state file exists with defaults
if [ ! -f "$STATE_FILE" ]; then
    mkdir -p "$(dirname "$STATE_FILE")"
    printf '{"last_checked_at":null,"processed_meeting_ids":[]}\n' > "$STATE_FILE"
fi

LAST_CHECKED_AT=$(python3 -c "
import json
d = json.load(open('$STATE_FILE'))
v = d.get('last_checked_at')
print(v if v else '')
" 2>/dev/null || echo "")

_log "info" "starting poll (mode=${DRAFT_GRANOLA_MODE} last_checked=${LAST_CHECKED_AT:-never})"

# ── Mode check ─────────────────────────────────────────────────────────────────
case "$DRAFT_GRANOLA_MODE" in
    mcp)
        # MCP mode: verify Granola MCP is registered in any Claude config file.
        # claude mcp add can write to ~/.claude/settings.json (user-scoped) OR
        # to a project-local .claude.json — so we use `claude mcp list` as the
        # authoritative check rather than reading a specific file directly.
        if ! claude mcp list 2>/dev/null | grep -qi granola; then
            _log "warn" "mcp mode set but Granola MCP not found — run /draft:connect granola to configure"
            exit 0
        fi
        ;;
    api)
        # API mode: check that granola_api_token is set in secrets.json
        if [ ! -f "$DRAFT_SECRETS" ]; then
            _log "warn" "api mode set but config/secrets.json not found — run /draft:connect granola to configure"
            exit 0
        fi
        GRANOLA_TOKEN=$(python3 -c "
import json, sys
d = json.load(open('$DRAFT_SECRETS'))
t = d.get('granola_api_token', '')
if not t:
    sys.exit(1)
print(t)
" 2>/dev/null || echo "")
        if [ -z "$GRANOLA_TOKEN" ]; then
            _log "warn" "api mode set but granola_api_token missing from config/secrets.json — run /draft:connect granola"
            exit 0
        fi
        ;;
    *)
        _log "error" "unknown DRAFT_GRANOLA_MODE='${DRAFT_GRANOLA_MODE}' — expected 'mcp' or 'api'"
        exit 1
        ;;
esac

# ── Helper: update state file ─────────────────────────────────────────────────
# Usage: _update_state [newline-separated meeting IDs to append]
_update_state() {
    local new_ids="${1:-}"
    python3 - <<PYEOF
import json

try:
    with open("$STATE_FILE") as f:
        state = json.load(f)
except Exception:
    state = {"processed_meeting_ids": []}

state["last_checked_at"] = "$CURRENT_TS"

# Append any new meeting IDs — avoid duplicates
new_ids_str = """$new_ids"""
for mid in new_ids_str.strip().splitlines():
    mid = mid.strip()
    if mid and mid not in state["processed_meeting_ids"]:
        state["processed_meeting_ids"].append(mid)

with open("$STATE_FILE", "w") as f:
    json.dump(state, f, indent=2)
PYEOF
}

# ── Build context payload for synthesizer ─────────────────────────────────────
# Write a context file for the synthesizer rather than a job file.
# Granola synthesis is time-triggered, not event-triggered — no session job exists.
CONTEXT_FILE=$(mktemp /tmp/draft-granola-context-XXXXXX)
trap 'rm -f "$CONTEXT_FILE"' EXIT

CURRENT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 - <<PYEOF
import json

try:
    with open("$STATE_FILE") as f:
        state = json.load(f)
    processed_ids = state.get("processed_meeting_ids", [])
except Exception:
    processed_ids = []

context = {
    "type": "granola",
    "mode": "$DRAFT_GRANOLA_MODE",
    "profile": "$DRAFT_ACTIVE_PROFILE",
    "timestamp": "$CURRENT_TS",
    "last_checked_at": "$LAST_CHECKED_AT" if "$LAST_CHECKED_AT" else None,
    "state_file": "$STATE_FILE",
    "processed_meeting_ids": processed_ids
}

with open("$CONTEXT_FILE", "w") as f:
    json.dump(context, f, indent=2)
PYEOF

# ── Call synthesizer ───────────────────────────────────────────────────────────
SYNTH_OUTPUT=$(mktemp /tmp/draft-granola-output-XXXXXX)
trap 'rm -f "$CONTEXT_FILE" "$SYNTH_OUTPUT"' EXIT

bash "$SYNTHESIZER" "$CONTEXT_FILE" > "$SYNTH_OUTPUT" 2>>"$DRAFT_LOGS/daemon.log"
SYNTH_EXIT=$?

if [ $SYNTH_EXIT -ne 0 ]; then
    _log "error" "synthesizer exited $SYNTH_EXIT — check logs for details"
    exit 1
fi

# ── Check for empty / no-update output ────────────────────────────────────────
if [ ! -s "$SYNTH_OUTPUT" ]; then
    _log "info" "no output from synthesizer — no new meetings to process"
    # Still update last_checked_at so we don't re-scan the same window
    _update_state
    exit 0
fi

if grep -q "context_updates: \[\]" "$SYNTH_OUTPUT" 2>/dev/null; then
    _log "info" "synthesizer found no team-relevant updates"
    _update_state
    exit 0
fi

# ── Write to proposals/ ────────────────────────────────────────────────────────
WORKSPACE="$HOME/.draft/workspaces/${DRAFT_ACTIVE_PROFILE}"
STAGING_DIR="${WORKSPACE}/proposals"
mkdir -p "$STAGING_DIR"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGING_FILE="${STAGING_DIR}/${TIMESTAMP}-granola.md"

cp "$SYNTH_OUTPUT" "$STAGING_FILE"
_log "info" "staged at $STAGING_FILE"

# Extract meeting IDs from the proposal YAML so we can mark them as processed
NEW_MEETING_IDS=$(python3 - <<PYEOF
import re, sys

try:
    content = open("$SYNTH_OUTPUT").read()
    # Extract YAML frontmatter
    m = re.search(r'^---\n(.+?)\n---', content, re.DOTALL)
    if not m:
        sys.exit(0)
    front = m.group(1)
    # Extract meeting_ids list
    ids_block = re.search(r'^meeting_ids:\s*\n((?:[ \t]+-[ \t]+\S+\n?)+)', front, re.MULTILINE)
    if not ids_block:
        sys.exit(0)
    for line in ids_block.group(1).splitlines():
        mid = re.sub(r'^[ \t]+-[ \t]+', '', line).strip()
        if mid and not mid.startswith('['):
            print(mid)
except Exception:
    pass
PYEOF
)

_update_state "$NEW_MEETING_IDS"
_log "info" "poll complete — state updated (last_checked_at=$CURRENT_TS, new_ids=$(echo "$NEW_MEETING_IDS" | grep -c . || echo 0))"
exit 0
