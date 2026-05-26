#!/bin/bash
# start.sh — resume a stopped Draft daemon
#
# Re-enables a daemon that was stopped with stop.sh.
# Does NOT re-run the full install — use install.sh for first-time setup.
#
# Usage:
#   bash ~/.draft/background/start.sh

PLIST_LABEL="com.draft.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

if [ ! -f "$PLIST_PATH" ]; then
    echo "[Draft Daemon] Not installed. Run install.sh first."
    exit 1
fi

if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
    echo "[Draft Daemon] Already running (PID $(launchctl list "$PLIST_LABEL" | grep '"PID"' | grep -oE '[0-9]+'))."
else
    launchctl load "$PLIST_PATH"
    sleep 1
    if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
        echo "[Draft Daemon] Started."
    else
        echo "[Draft Daemon] Failed to start — check logs at ~/.draft/background/logs/daemon-error.log" >&2
        exit 1
    fi
fi
