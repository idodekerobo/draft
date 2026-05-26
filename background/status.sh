#!/bin/bash
# status.sh — Draft daemon status
#
# Shows: LaunchAgent status, dependency warnings, queue depth, recent log lines.
#
# Usage:
#   bash ~/.draft/background/status.sh

DRAFT_GLOBAL="$HOME/.draft"
DRAFT_BACKGROUND="$DRAFT_GLOBAL/background"
PLIST_LABEL="com.draft.daemon"
LOG="$DRAFT_BACKGROUND/logs/daemon.log"
ERR_LOG="$DRAFT_BACKGROUND/logs/daemon-error.log"

echo "=== Draft Daemon Status ==="
echo ""

# ── 1. LaunchAgent status ──────────────────────────────────────────────────────
if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
    # launchctl list <service> returns a plist-style dict, not a table.
    # Parse "PID" and "LastExitStatus" fields directly via grep.
    _pid=$(launchctl list "$PLIST_LABEL" 2>/dev/null | grep '"PID"' | grep -oE '[0-9]+')
    _exit=$(launchctl list "$PLIST_LABEL" 2>/dev/null | grep '"LastExitStatus"' | grep -oE '[0-9]+')
    echo "Status:   RUNNING"
    echo "  PID:    ${_pid:-unknown}"
    echo "  Last exit code: ${_exit:--}"
else
    echo "Status:   NOT RUNNING"
    echo "  To start: bash ~/.draft/background/install.sh"
fi
echo ""

# ── 2. Active profile ─────────────────────────────────────────────────────────
_active_profile="default"
if [ -f "$DRAFT_GLOBAL/active-profile" ]; then
    _p=$(tr -d '[:space:]' < "$DRAFT_GLOBAL/active-profile")
    [ -n "$_p" ] && _active_profile="$_p"
fi
echo "Profile:  $_active_profile"
echo ""

# ── 3. Dependency checks ───────────────────────────────────────────────────────
echo "Dependencies:"
if command -v claude &>/dev/null; then
    echo "  claude  ... ok"
else
    echo "  claude  ... NOT FOUND — synthesis disabled until installed"
fi
if command -v tmux &>/dev/null; then
    echo "  tmux    ... ok"
else
    echo "  tmux    ... NOT FOUND — claude-code adapter unavailable"
fi
if command -v python3 &>/dev/null; then
    echo "  python3 ... ok"
else
    echo "  python3 ... NOT FOUND — daemon requires python3"
fi
echo ""

# ── 4. Queue depth ─────────────────────────────────────────────────────────────
_pending=0
_failed=0
if [ -d "$DRAFT_BACKGROUND/pending" ]; then
    _pending=$(find "$DRAFT_BACKGROUND/pending" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
fi
if [ -d "$DRAFT_BACKGROUND/failed" ]; then
    _failed=$(find "$DRAFT_BACKGROUND/failed" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
fi
echo "Queue:    $_pending pending, $_failed failed"
if [ "$_failed" -gt 0 ]; then
    echo "  Failed jobs at: $DRAFT_BACKGROUND/failed/"
fi
echo ""

# ── 5. Recent log lines ────────────────────────────────────────────────────────
echo "Recent logs (last 5):"
if [ -f "$LOG" ] && [ -s "$LOG" ]; then
    tail -5 "$LOG"
else
    echo "  (no log entries yet)"
fi

if [ -f "$ERR_LOG" ] && [ -s "$ERR_LOG" ]; then
    echo ""
    echo "Recent errors (last 3):"
    tail -3 "$ERR_LOG"
fi
