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
_UID=$(id -u)
_SERVICE_TARGET="gui/${_UID}/${PLIST_LABEL}"

if [ ! -f "$PLIST_PATH" ]; then
    echo "[Draft Daemon] Not installed. Run install.sh first."
    exit 1
fi

# Check if already running
if launchctl print "$_SERVICE_TARGET" 2>/dev/null | grep -q 'state = running'; then
    echo "[Draft Daemon] Already running."
    exit 0
fi

# Try to bootstrap (register) if not registered, then kickstart
if ! launchctl print "$_SERVICE_TARGET" &>/dev/null; then
    launchctl bootstrap "gui/${_UID}" "$PLIST_PATH"
fi
launchctl kickstart -k "$_SERVICE_TARGET"

sleep 1
if launchctl print "$_SERVICE_TARGET" &>/dev/null; then
    echo "[Draft Daemon] Started."
else
    echo "[Draft Daemon] Failed to start — check logs at ~/.draft/background/logs/daemon-error.log" >&2
    exit 1
fi
