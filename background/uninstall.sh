#!/bin/bash
# uninstall.sh — Draft daemon uninstaller
#
# Stops the daemon and removes the LaunchAgent plist.
# Does NOT remove ~/.draft/background/ files — logs and pending jobs are preserved.
#
# Usage:
#   bash ~/.draft/background/uninstall.sh

PLIST_LABEL="com.draft.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
DRAFT_BACKGROUND="$HOME/.draft/background"
_UID=$(id -u)
_SERVICE_TARGET="gui/${_UID}/${PLIST_LABEL}"

echo "[Draft Daemon] Uninstalling..."

# Stop the daemon if running
if launchctl bootout "$_SERVICE_TARGET" 2>/dev/null; then
    echo "[Draft Daemon] Daemon stopped"
else
    echo "[Draft Daemon] Daemon was not running"
fi

# Remove the plist
if [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH"
    echo "[Draft Daemon] Plist removed: $PLIST_PATH"
else
    echo "[Draft Daemon] Plist not found (already removed)"
fi

echo ""
echo "[Draft Daemon] Uninstall complete."
echo "  Background files preserved at: $DRAFT_BACKGROUND"
echo "  To remove all daemon files:    rm -rf $DRAFT_BACKGROUND"
echo "  To reinstall:                  bash \${CLAUDE_PLUGIN_ROOT}/background/install.sh"
