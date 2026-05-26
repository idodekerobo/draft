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

echo "[Draft Daemon] Uninstalling..."

# Stop the daemon if running
if launchctl list "$PLIST_LABEL" &>/dev/null 2>&1; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
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
