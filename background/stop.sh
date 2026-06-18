#!/bin/bash
# stop.sh — pause the Draft daemon without uninstalling
#
# Stops the process and removes the service registration so it doesn't restart.
# Installation is preserved — run start.sh to resume.
#
# Usage:
#   bash ~/.draft/background/stop.sh

PLIST_LABEL="com.draft.daemon"
_UID=$(id -u)
_SERVICE_TARGET="gui/${_UID}/${PLIST_LABEL}"

# bootout deregisters the service — treats "not bootstrapped" as already stopped
if launchctl bootout "$_SERVICE_TARGET" 2>/dev/null; then
    echo "[Draft Daemon] Stopped. Run 'bash ~/.draft/background/start.sh' to resume."
else
    echo "[Draft Daemon] Already stopped."
fi
