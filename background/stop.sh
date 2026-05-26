#!/bin/bash
# stop.sh — pause the Draft daemon without uninstalling
#
# Stops the process and disables KeepAlive so it doesn't restart.
# Installation is preserved — run start.sh to resume.
#
# Usage:
#   bash ~/.draft/background/stop.sh

PLIST_LABEL="com.draft.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

if [ ! -f "$PLIST_PATH" ]; then
    echo "[Draft Daemon] Not installed. Run install.sh first."
    exit 1
fi

if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
    launchctl unload "$PLIST_PATH"
    echo "[Draft Daemon] Stopped. Run 'bash ~/.draft/background/start.sh' to resume."
else
    echo "[Draft Daemon] Already stopped."
fi
