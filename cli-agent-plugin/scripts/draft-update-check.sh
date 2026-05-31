#!/bin/bash
# Draft — Update check
#
# Checks if a Draft update is available. Writes result to ~/.draft/config.json
# (last_update_check) and ~/.draft/last-update-check (flat file, backwards compat).
# Called in background from session hooks — never blocks session start.
#
# Flags:
#   --force   Bypass TTL cache and check immediately

DRAFT_DIR="$HOME/.draft"
CONFIG_FILE="$DRAFT_DIR/config.json"
LAST_CHECK_FILE="$DRAFT_DIR/last-update-check"
REMOTE_VERSION_URL="https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/main/VERSION"
FORCE="${1:-}"

# ── Read installed version from config.json, fall back to flat file ────────────

INSTALLED=$(python3 -c "
import json, pathlib
cfg_path = pathlib.Path('$CONFIG_FILE')
if cfg_path.exists():
    cfg = json.loads(cfg_path.read_text())
    print(cfg.get('plugin_version', ''))
" 2>/dev/null | tr -d '[:space:]' || echo "")

if [ -z "$INSTALLED" ]; then
    INSTALLED=$(cat "$DRAFT_DIR/version" 2>/dev/null | tr -d '[:space:]' || echo "")
fi

# No installed version recorded — nothing to check
if [ -z "$INSTALLED" ]; then
    exit 0
fi

# ── TTL check using checked_at from config.json ────────────────────────────────
# UP_TO_DATE:        60 min TTL
# UPGRADE_AVAILABLE: 720 min TTL (12 hours)

if [ "$FORCE" != "--force" ]; then
    CACHE_HIT=$(python3 -c "
import json, pathlib, datetime
cfg_path = pathlib.Path('$CONFIG_FILE')
if not cfg_path.exists():
    print('miss')
    exit()
cfg = json.loads(cfg_path.read_text())
luc = cfg.get('last_update_check', {})
status = luc.get('status', '')
checked_at = luc.get('checked_at', '')
if not status or not checked_at:
    print('miss')
    exit()
try:
    then = datetime.datetime.fromisoformat(checked_at.replace('Z', '+00:00'))
    now = datetime.datetime.now(datetime.timezone.utc)
    elapsed_min = (now - then).total_seconds() / 60
    if status == 'UP_TO_DATE' and elapsed_min < 60:
        print('hit')
    elif status == 'UPGRADE_AVAILABLE' and elapsed_min < 720:
        print('hit')
    else:
        print('miss')
except Exception:
    print('miss')
" 2>/dev/null || echo "miss")
    if [ "$CACHE_HIT" = "hit" ]; then
        exit 0
    fi
fi

# ── Fetch remote version (5s timeout, fail silently) ──────────────────────────

REMOTE=$(curl -fsSL --max-time 5 "$REMOTE_VERSION_URL" 2>/dev/null | tr -d '[:space:]' || echo "")
if [ -z "$REMOTE" ]; then
    exit 0  # Network error — keep old cache, don't overwrite
fi

# ── Write result to config.json and flat file ─────────────────────────────────

mkdir -p "$DRAFT_DIR"

if [ "$INSTALLED" = "$REMOTE" ]; then
    STATUS="UP_TO_DATE"
    FLAT_LINE="UP_TO_DATE $INSTALLED"
else
    STATUS="UPGRADE_AVAILABLE"
    FLAT_LINE="UPGRADE_AVAILABLE $INSTALLED $REMOTE"
fi

CHECKED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

python3 -c "
import json, pathlib
cfg_path = pathlib.Path('$CONFIG_FILE')
cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {'version': '1', 'tools': {}}
cfg['last_update_check'] = {
    'status': '$STATUS',
    'installed_version': '$INSTALLED',
    'latest_version': '$REMOTE',
    'checked_at': '$CHECKED_AT',
}
cfg_path.write_text(json.dumps(cfg, indent=2) + '\n')
" 2>/dev/null || true

# Keep flat file in sync for readers that haven't migrated yet
echo "$FLAT_LINE" > "$LAST_CHECK_FILE"
