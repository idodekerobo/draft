#!/bin/bash
# slack-manager.sh — Draft Slack capture process manager
#
# Ensures slack-capture.ts is running if Slack is configured.
# Called by draft-background.ts every SLACK_MANAGER_INTERVAL seconds (default: 60s).
# Manages process lifecycle via PID file — starts if dead, exits if healthy.
#
# Does NOT start if:
#   - Slack not configured in secrets.json (no slack_app_token)
#   - bun not found on PATH
#   - slack-capture.ts not present

set -uo pipefail

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=config.sh
source "$DRAFT_BACKGROUND/config.sh"

CAPTURE_SCRIPT="$DRAFT_BACKGROUND/integrations/slack/slack-capture.js"
[ -f "$CAPTURE_SCRIPT" ] || CAPTURE_SCRIPT="$DRAFT_BACKGROUND/integrations/slack/slack-capture.ts"
PID_FILE="$DRAFT_BACKGROUND/integrations/slack/capture.pid"
LOG_FILE="$DRAFT_LOGS/slack-capture.log"

_log() {
    local level="$1" msg="$2"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"ts":"%s","level":"%s","component":"slack-manager","msg":"%s"}\n' \
        "$ts" "$level" "$msg"
}

# ── Preflight: check Slack is configured ───────────────────────────────────────

if [ ! -f "$DRAFT_SECRETS" ]; then
    # Not configured — exit silently (common before setup)
    exit 0
fi

SLACK_APP_TOKEN=$(python3 -c "
import json, sys
try:
    d = json.load(open('$DRAFT_SECRETS'))
    t = d.get('slack_app_token', '')
    if t: print(t)
except: pass
" 2>/dev/null || echo "")

if [ -z "$SLACK_APP_TOKEN" ]; then
    # Slack not configured — exit silently
    exit 0
fi

# ── Preflight: check bun ───────────────────────────────────────────────────────
# Fall back to Draft's bundled bun runtime if bun is not on the system PATH.
# The daemon's plist PATH is minimal (no ~/.draft/bin) so we check explicitly.
BUN_BIN=$(command -v bun 2>/dev/null || echo "$HOME/.draft/bin/bun")
if [ ! -x "$BUN_BIN" ]; then
    _log "warn" "bun not found on PATH or at ~/.draft/bin/bun — slack-capture unavailable. Install Draft app to get the bundled runtime."
    exit 0
fi

# ── Preflight: check capture script ───────────────────────────────────────────

if [ ! -f "$CAPTURE_SCRIPT" ]; then
    _log "warn" "slack-capture.ts not found at $CAPTURE_SCRIPT"
    exit 0
fi

# ── Check if capture process is already running ────────────────────────────────

mkdir -p "$(dirname "$PID_FILE")"

if [ -f "$PID_FILE" ]; then
    CURRENT_PID=$(cat "$PID_FILE" | tr -d '[:space:]')
    if [ -n "$CURRENT_PID" ] && kill -0 "$CURRENT_PID" 2>/dev/null; then
        # Process is alive — nothing to do
        exit 0
    fi
    # Process is dead — clean up stale PID file
    _log "warn" "slack-capture pid=$CURRENT_PID is gone — restarting"
    rm -f "$PID_FILE"
fi

# ── Start the capture process ──────────────────────────────────────────────────

mkdir -p "$(dirname "$LOG_FILE")"

"$BUN_BIN" run "$CAPTURE_SCRIPT" >> "$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

_log "info" "slack-capture started (pid=$NEW_PID)"
exit 0
