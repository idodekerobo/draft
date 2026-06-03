#!/bin/bash
# synthesize.sh — Draft synthesis router
#
# Called by draft-background.ts for each pending job file.
# Checks the job is synthesis-eligible, delegates to the source adapter,
# handles timeout, and writes the output to proposals/.
#
# Usage: bash synthesize.sh <job_file>

set -uo pipefail

JOB_FILE="$1"

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=config.sh
source "$DRAFT_BACKGROUND/config.sh"

_log() {
    local level="$1" msg="$2"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"ts":"%s","level":"%s","msg":"%s"}\n' "$ts" "$level" "$msg" >> "$DRAFT_LOGS/daemon.log"
}

# ── Read job fields ────────────────────────────────────────────────────────────
SESSION_ID=$(python3 -c "
import json
d = json.load(open('$JOB_FILE'))
print(d.get('session_id', 'unknown'))
" 2>/dev/null || echo "unknown")

REASON=$(python3 -c "
import json
d = json.load(open('$JOB_FILE'))
print(d.get('reason', 'unknown'))
" 2>/dev/null || echo "unknown")

PROFILE=$(python3 -c "
import json
d = json.load(open('$JOB_FILE'))
print(d.get('profile', 'default'))
" 2>/dev/null || echo "default")

SESSION_SHORT="${SESSION_ID:0:8}"

# ── Skip non-clean exits ───────────────────────────────────────────────────────
# reason != "prompt_input_exit" means crash, force-kill, or other abnormal exit.
# Transcript may be incomplete — skip synthesis to avoid noise.
if [ "$REASON" != "prompt_input_exit" ]; then
    _log "info" "synthesize: skipping job (reason=$REASON session=$SESSION_SHORT profile=$PROFILE)"
    exit 0
fi

_log "info" "synthesize: starting (session=$SESSION_SHORT profile=$PROFILE)"

# ── Resolve source synthesizer ─────────────────────────────────────────────────
# Default source is "session" (Claude Code session transcript).
# Future: job file may encode a different source type (granola, slack).
SOURCE="${DRAFT_SOURCE:-claude-code-session}"
SYNTHESIZER_SCRIPT="$DRAFT_BACKGROUND/synthesizers/${SOURCE}.sh"

if [ ! -x "$SYNTHESIZER_SCRIPT" ]; then
    _log "error" "synthesize: source adapter not found: $SYNTHESIZER_SCRIPT (session=$SESSION_SHORT)"
    exit 1
fi

# ── Run with timeout ───────────────────────────────────────────────────────────
# 300s hard limit. Pure bash background+kill — avoids dependency on GNU timeout
# (not available by default on macOS; gtimeout requires coreutils).
SYNTH_OUTPUT=$(mktemp /tmp/draft-synth-router-XXXXXX)
trap 'rm -f "$SYNTH_OUTPUT"' EXIT

bash "$SYNTHESIZER_SCRIPT" "$JOB_FILE" > "$SYNTH_OUTPUT" 2>> "$DRAFT_LOGS/daemon.log" &
SYNTH_PID=$!

# Watchdog: kill synthesizer after 300s if still running
( sleep 300 && kill "$SYNTH_PID" 2>/dev/null ) &
KILLER_PID=$!

wait "$SYNTH_PID"
SYNTH_EXIT=$?

# Clean up watchdog
kill "$KILLER_PID" 2>/dev/null
wait "$KILLER_PID" 2>/dev/null || true

# exit 143 = SIGTERM, 137 = SIGKILL (killed by watchdog = timeout)
if [ $SYNTH_EXIT -eq 143 ] || [ $SYNTH_EXIT -eq 137 ]; then
    _log "error" "synthesize: timeout after 300s (session=$SESSION_SHORT) — moving job to failed/"
    exit 1
fi

if [ $SYNTH_EXIT -ne 0 ]; then
    _log "error" "synthesize: adapter exited $SYNTH_EXIT (session=$SESSION_SHORT)"
    exit 1
fi

# ── Validate output ────────────────────────────────────────────────────────────
if [ ! -s "$SYNTH_OUTPUT" ]; then
    _log "warn" "synthesize: empty output from adapter (session=$SESSION_SHORT) — nothing to stage"
    exit 0
fi

# Check for "No updates" signal from adapter
if grep -q "context_updates: \[\]" "$SYNTH_OUTPUT" 2>/dev/null; then
    _log "info" "synthesize: no team-relevant updates found (session=$SESSION_SHORT)"
    exit 0
fi

# ── Write to proposals/ ────────────────────────────────────────────────────────
# Profile-specific proposals dir. Curator reviews these before running /publish-team.
WORKSPACE="$HOME/.draft/workspaces/${PROFILE}"
STAGING_DIR="${WORKSPACE}/proposals"
mkdir -p "$STAGING_DIR" "$STAGING_DIR/accepted" "$STAGING_DIR/rejected"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGING_FILE="${STAGING_DIR}/${TIMESTAMP}-${SESSION_SHORT}.md"

cp "$SYNTH_OUTPUT" "$STAGING_FILE"

_log "info" "synthesize: staged at $STAGING_FILE (session=$SESSION_SHORT profile=$PROFILE)"
exit 0
