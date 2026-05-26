#!/bin/bash
# slack-analyzer.sh — Draft Slack synthesis runner
#
# Called by draft-daemon.sh on DRAFT_SLACK_ANALYSIS interval (default: 4hr).
# For each configured channel:
#   1. Calls slack-rebuild.ts → reconstructed thread markdown
#   2. Passes reconstructed files to synthesizers/slack.sh
#   3. Writes proposals to proposals/ if synthesis produces output
#
# Analogous to granola-poller.sh — time-triggered, writes proposals/ directly.
# State: background/integrations/slack/captures/state.json (last_analysis_at per channel)

set -uo pipefail

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=config.sh
source "$DRAFT_BACKGROUND/config.sh"

CAPTURE_DIR="$DRAFT_BACKGROUND/integrations/slack/captures"
STATE_FILE="$CAPTURE_DIR/state.json"
SYNTHESIZER="$DRAFT_BACKGROUND/synthesizers/slack.sh"
REBUILD_SCRIPT="$DRAFT_BACKGROUND/integrations/slack/slack-rebuild.ts"

_log() {
    local level="$1" msg="$2"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"ts":"%s","level":"%s","component":"slack-analyzer","msg":"%s"}\n' \
        "$ts" "$level" "$msg"
}

# ── Preflight ──────────────────────────────────────────────────────────────────

if [ ! -x "$SYNTHESIZER" ]; then
    _log "warn" "synthesizers/slack.sh not found — skipping analysis"
    exit 0
fi

if [ ! -f "$REBUILD_SCRIPT" ]; then
    _log "warn" "slack-rebuild.ts not found — skipping analysis"
    exit 0
fi

if ! command -v bun &>/dev/null; then
    _log "warn" "bun not found — skipping analysis"
    exit 0
fi

# ── Read Slack config ──────────────────────────────────────────────────────────

if [ ! -f "$DRAFT_SECRETS" ]; then
    exit 0
fi

SLACK_CHANNELS=$(python3 -c "
import json, sys
try:
    d = json.load(open('$DRAFT_SECRETS'))
    channels = d.get('slack_allowlist_channels', [])
    print(' '.join(channels))
except: pass
" 2>/dev/null || echo "")

if [ -z "$SLACK_CHANNELS" ]; then
    _log "warn" "no channels configured in secrets.json — skipping analysis"
    exit 0
fi

CURRENT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ANALYSIS_WINDOW="${DRAFT_SLACK_ANALYSIS_WINDOW:-8}"  # hours to look back

_log "info" "starting analysis (channels=$SLACK_CHANNELS window=${ANALYSIS_WINDOW}h)"

# ── Rebuild threads for each channel ──────────────────────────────────────────

RECONSTRUCTED_FILES=()

for CHANNEL_ID in $SLACK_CHANNELS; do
    # Resolve channel name from users cache (fall back to ID)
    CHANNEL_NAME=$(python3 -c "
import json, sys, os
try:
    roles_file = os.path.join('$DRAFT_WORKSPACE', 'config', 'slack-roles.json')
    d = json.load(open(roles_file))
    # Look for channel name mapping (stored under __channels key)
    channels = d.get('__channels', {})
    print(channels.get('$CHANNEL_ID', '$CHANNEL_ID'))
except: print('$CHANNEL_ID')
" 2>/dev/null || echo "$CHANNEL_ID")

    REBUILT=$(bun run "$REBUILD_SCRIPT" \
        --channel "$CHANNEL_ID" \
        --channel-name "$CHANNEL_NAME" \
        --hours "$ANALYSIS_WINDOW" \
        --capture-dir "$CAPTURE_DIR" 2>>"$DRAFT_LOGS/daemon.log" || echo "")

    if [ -n "$REBUILT" ] && [ -f "$REBUILT" ]; then
        RECONSTRUCTED_FILES+=("$REBUILT")
        _log "info" "rebuilt $CHANNEL_ID → $REBUILT"
    else
        _log "info" "no messages for $CHANNEL_ID in last ${ANALYSIS_WINDOW}h — skipping"
    fi
done

if [ ${#RECONSTRUCTED_FILES[@]} -eq 0 ]; then
    _log "info" "no reconstructed files — nothing to synthesize"
    exit 0
fi

# ── Build context file for synthesizer ────────────────────────────────────────

CONTEXT_FILE=$(mktemp /tmp/draft-slack-context-XXXXXX.json)
trap 'rm -f "$CONTEXT_FILE"' EXIT

python3 - <<PYEOF
import json, os

reconstructed = ${RECONSTRUCTED_FILES[@]+"$(printf '"%s",' "${RECONSTRUCTED_FILES[@]}" | sed 's/,$//')"}

context = {
    "type": "slack",
    "profile": "$DRAFT_ACTIVE_PROFILE",
    "timestamp": "$CURRENT_TS",
    "analysis_window_hours": $ANALYSIS_WINDOW,
    "channels": "$SLACK_CHANNELS".split(),
    "reconstructed_files": [f for f in "$( printf '%s\n' "${RECONSTRUCTED_FILES[@]}" )".split('\n') if f],
    "workspace": "$DRAFT_WORKSPACE",
}

with open("$CONTEXT_FILE", "w") as f:
    json.dump(context, f, indent=2)
PYEOF

# ── Call synthesizer ───────────────────────────────────────────────────────────

SYNTH_OUTPUT=$(mktemp /tmp/draft-slack-output-XXXXXX.md)
trap 'rm -f "$CONTEXT_FILE" "$SYNTH_OUTPUT"' EXIT

bash "$SYNTHESIZER" "$CONTEXT_FILE" > "$SYNTH_OUTPUT" 2>> "$DRAFT_LOGS/daemon.log"
SYNTH_EXIT=$?

if [ $SYNTH_EXIT -ne 0 ]; then
    _log "error" "synthesizer exited $SYNTH_EXIT"
    exit 1
fi

if [ ! -s "$SYNTH_OUTPUT" ]; then
    _log "info" "no synthesis output — nothing team-relevant found"
    exit 0
fi

if grep -q "context_updates: \[\]" "$SYNTH_OUTPUT" 2>/dev/null; then
    _log "info" "synthesizer found no team-relevant updates"
    exit 0
fi

# ── Write to proposals/ ────────────────────────────────────────────────────────
# If the LLM set replaces_proposal, overwrite that file. Otherwise create new.

STAGING_DIR="$DRAFT_WORKSPACE/proposals"
mkdir -p "$STAGING_DIR"

REPLACES=$(python3 -c "
import re, sys
try:
    content = open('$SYNTH_OUTPUT').read()
    m = re.search(r'^---\n(.+?)\n---', content, re.DOTALL)
    if not m:
        sys.exit(0)
    r = re.search(r'^replaces_proposal:\s*(\S+)', m.group(1), re.MULTILINE)
    if r:
        print(r.group(1))
except Exception:
    pass
" 2>/dev/null || echo "")

if [ -n "$REPLACES" ] && [ -f "$STAGING_DIR/$REPLACES" ]; then
    cp "$SYNTH_OUTPUT" "$STAGING_DIR/$REPLACES"
    _log "info" "overwrote existing proposal: $REPLACES"
else
    if [ -n "$REPLACES" ]; then
        _log "warn" "replaces_proposal '$REPLACES' not found in proposals/ — creating new instead"
    fi
    TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
    STAGING_FILE="${STAGING_DIR}/${TIMESTAMP}-slack.md"
    cp "$SYNTH_OUTPUT" "$STAGING_FILE"
    _log "info" "staged at $STAGING_FILE"
fi
exit 0
