#!/bin/bash
# Draft — Update check
#
# Checks if a Draft update is available. Writes result to ~/.draft/last-update-check.
# Called in background from session hooks — never blocks session start.
#
# Output (written to file, not stdout):
#   UP_TO_DATE <version>
#   UPGRADE_AVAILABLE <installed> <latest>
#
# Flags:
#   --force   Bypass TTL cache and check immediately

DRAFT_DIR="$HOME/.draft"
LAST_CHECK_FILE="$DRAFT_DIR/last-update-check"
VERSION_FILE="$DRAFT_DIR/version"
REMOTE_VERSION_URL="https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/main/VERSION"
FORCE="${1:-}"

# No installed version recorded — nothing to check
INSTALLED=$(cat "$VERSION_FILE" 2>/dev/null | tr -d '[:space:]' || echo "")
if [ -z "$INSTALLED" ]; then
    exit 0
fi

# ── TTL check — avoid hitting remote on every session ─────────────────────────
# UP_TO_DATE:        60 min TTL
# UPGRADE_AVAILABLE: 720 min TTL (12 hours)

if [ "$FORCE" != "--force" ] && [ -f "$LAST_CHECK_FILE" ]; then
    LAST_STATUS=$(awk '{print $1}' "$LAST_CHECK_FILE" 2>/dev/null || echo "")

    # mtime — macOS vs Linux
    if stat -f "%m" "$LAST_CHECK_FILE" &>/dev/null; then
        LAST_MTIME=$(stat -f "%m" "$LAST_CHECK_FILE")
    else
        LAST_MTIME=$(stat -c "%Y" "$LAST_CHECK_FILE" 2>/dev/null || echo 0)
    fi

    NOW=$(date +%s)
    ELAPSED=$(( NOW - LAST_MTIME ))

    if [ "$LAST_STATUS" = "UP_TO_DATE" ] && [ "$ELAPSED" -lt 3600 ]; then
        exit 0
    elif [ "$LAST_STATUS" = "UPGRADE_AVAILABLE" ] && [ "$ELAPSED" -lt 43200 ]; then
        exit 0
    fi
fi

# ── Fetch remote version (5s timeout, fail silently) ──────────────────────────

REMOTE=$(curl -fsSL --max-time 5 "$REMOTE_VERSION_URL" 2>/dev/null | tr -d '[:space:]' || echo "")
if [ -z "$REMOTE" ]; then
    exit 0  # Network error — keep old cache, don't overwrite
fi

# ── Write result ──────────────────────────────────────────────────────────────

mkdir -p "$DRAFT_DIR"

if [ "$INSTALLED" = "$REMOTE" ]; then
    echo "UP_TO_DATE $INSTALLED" > "$LAST_CHECK_FILE"
else
    echo "UPGRADE_AVAILABLE $INSTALLED $REMOTE" > "$LAST_CHECK_FILE"
fi
