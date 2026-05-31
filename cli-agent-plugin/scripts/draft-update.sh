#!/bin/bash
# Draft — Self-update
#
# Downloads the latest release tarball from GitHub, extracts it to a temp
# directory, and runs populate-shared.sh to update ~/.draft/shared/ in place.
# All tool config dirs symlink into ~/.draft/shared/, so they pick up changes
# automatically — no per-tool curl loops needed.
#
# Called by the /draft:update skill after user confirmation.
# Safe: never touches ~/.draft/workspaces/ (user's context data).
#
# If a release is tagged [hooks-changed], config merges are re-run for each
# installed tool. Otherwise only the shared content files are updated.

set -euo pipefail

DRAFT_DIR="$HOME/.draft"
VERSION_FILE="$DRAFT_DIR/version"
LAST_CHECK_FILE="$DRAFT_DIR/last-update-check"
GITHUB_API="https://api.github.com/repos/idodekerobo/draft-cli-plugin/releases/latest"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[Draft]${NC} $1"; }
warn() { echo -e "${YELLOW}[Draft]${NC} $1"; }
err()  { echo -e "${RED}[Draft]${NC} $1" >&2; }

INSTALLED=$(cat "$VERSION_FILE" 2>/dev/null | tr -d '[:space:]' || echo "unknown")

log "Fetching latest release info..."

# ── Fetch release metadata ─────────────────────────────────────────────────────

RELEASE_JSON=$(curl -fsSL --max-time 10 "$GITHUB_API" 2>/dev/null || echo "")

if [ -z "$RELEASE_JSON" ]; then
    err "Could not fetch release info from GitHub. Check your connection and try again."
    exit 1
fi

LATEST_TAG=$(echo "$RELEASE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tag_name',''))" 2>/dev/null || echo "")
RELEASE_BODY=$(echo "$RELEASE_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('body',''))" 2>/dev/null || echo "")

if [ -z "$LATEST_TAG" ]; then
    err "Could not parse latest version from GitHub API response."
    exit 1
fi

LATEST="${LATEST_TAG#v}"  # strip leading 'v' if present

# ── Already current? ───────────────────────────────────────────────────────────

if [ "$INSTALLED" = "$LATEST" ]; then
    log "Already on the latest version (v$INSTALLED). Nothing to do."
    exit 0
fi

echo ""
log "Updating Draft: v$INSTALLED → v$LATEST"
echo ""

# ── Download tarball ───────────────────────────────────────────────────────────

TARBALL_URL="https://github.com/idodekerobo/draft-cli-plugin/archive/refs/tags/$LATEST_TAG.tar.gz"
TMP_TARBALL=$(mktemp /tmp/draft-plugin-XXXXXX.tar.gz)
TMP_DIR=$(mktemp -d /tmp/draft-plugin-XXXXXX)

log "Downloading release tarball..."
if ! curl -fsSL --max-time 60 "$TARBALL_URL" -o "$TMP_TARBALL"; then
    err "Failed to download tarball from $TARBALL_URL"
    rm -f "$TMP_TARBALL"
    exit 1
fi

log "Extracting..."
tar -xzf "$TMP_TARBALL" -C "$TMP_DIR" --strip-components=1
rm -f "$TMP_TARBALL"

# ── Populate ~/.draft/shared/ from extracted tarball ──────────────────────────
# populate-shared.sh auto-detects PLUGIN_ROOT from its own location in the
# extracted dir. All symlinks from tool config dirs pick up changes immediately.

log "Updating ~/.draft/shared/..."
bash "$TMP_DIR/scripts/populate-shared.sh"

# ── Update TOML agents for Codex (not symlinked — different format) ────────────

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
if [ -f "$CODEX_HOME/agents/draft-researcher.toml" ]; then
    log "Updating Codex TOML agents..."
    for agent in draft-executor draft-learner draft-researcher; do
        cp "$TMP_DIR/.codex/agents/$agent.toml" "$CODEX_HOME/agents/$agent.toml"
        log "  Updated $agent.toml"
    done
fi

# ── Re-merge configs if hooks schema changed ───────────────────────────────────
# Only runs when the release notes contain [hooks-changed].
# Config merges are idempotent but expensive — skip when not needed.

HOOKS_CHANGED=false
if echo "$RELEASE_BODY" | grep -q "\[hooks-changed\]"; then
    HOOKS_CHANGED=true
fi

if [ "$HOOKS_CHANGED" = true ]; then
    warn "Hooks schema changed in this release — re-merging config files..."

    # Codex hooks.json / config.toml
    if [ -f "$CODEX_HOME/hooks/draft/inject-context.sh" ]; then
        log "  Re-running codex config merge..."
        bash "$TMP_DIR/scripts/codex-setup.sh" 2>/dev/null || \
            warn "  Codex config merge failed — run \`draft add codex\` manually."
    fi

    # Cursor hooks.json
    CURSOR_HOME="${CURSOR_HOME:-$HOME/.cursor}"
    if [ -f "$CURSOR_HOME/hooks/draft/cursor-session-start.sh" ]; then
        log "  Re-running cursor config merge..."
        bash "$TMP_DIR/scripts/cursor-setup.sh" 2>/dev/null || \
            warn "  Cursor config merge failed — run \`draft add cursor\` manually."
    fi
fi

# ── Update shared update scripts ───────────────────────────────────────────────
# These live at ~/.draft/scripts/ (not ~/.draft/shared/) and manage the update
# process itself — always update them so this script self-updates.

log "Updating shared scripts..."
mkdir -p "$DRAFT_DIR/scripts"
cp "$TMP_DIR/scripts/draft-update-check.sh" "$DRAFT_DIR/scripts/draft-update-check.sh"
cp "$TMP_DIR/scripts/draft-update.sh" "$DRAFT_DIR/scripts/draft-update.sh"
chmod +x "$DRAFT_DIR/scripts/"*.sh
log "  Shared scripts updated at ~/.draft/scripts/"

# ── Clean up temp dir ──────────────────────────────────────────────────────────

rm -rf "$TMP_DIR"

# ── Record new version ─────────────────────────────────────────────────────────

CHECKED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

echo "$LATEST" > "$VERSION_FILE"
echo "UP_TO_DATE $LATEST" > "$LAST_CHECK_FILE"

python3 -c "
import json, pathlib
cfg_path = pathlib.Path('$DRAFT_DIR/config.json')
cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {'version': '1', 'tools': {}}
cfg['plugin_version'] = '$LATEST'
cfg['last_update_check'] = {
    'status': 'UP_TO_DATE',
    'installed_version': '$LATEST',
    'latest_version': '$LATEST',
    'checked_at': '$CHECKED_AT',
}
cfg_path.write_text(json.dumps(cfg, indent=2) + '\n')
" 2>/dev/null || true

echo ""
log "Draft updated to v$LATEST."
echo ""
echo "  Restart your session to apply changes."
echo ""
