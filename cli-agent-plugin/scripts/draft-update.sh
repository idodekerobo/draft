#!/bin/bash
# Draft — Self-update
#
# Downloads the latest version from GitHub Releases and updates all installed files.
# Called by the /draft:update skill after user confirmation.
#
# Safe: never touches ~/.draft/workspace/ (user's PM brain data)

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

# ── Get latest tag from GitHub Releases API ───────────────────────────────────

LATEST_TAG=$(curl -fsSL --max-time 10 "$GITHUB_API" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tag_name',''))" \
    2>/dev/null || echo "")

if [ -z "$LATEST_TAG" ]; then
    err "Could not fetch latest version from GitHub. Check your connection and try again."
    exit 1
fi

LATEST="${LATEST_TAG#v}"  # strip leading 'v' if present

# ── Already current? ──────────────────────────────────────────────────────────

if [ "$INSTALLED" = "$LATEST" ]; then
    log "Already on the latest version (v$INSTALLED). Nothing to do."
    exit 0
fi

echo ""
log "Updating Draft: v$INSTALLED -> v$LATEST"
echo ""

GITHUB_RAW="https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/$LATEST_TAG"

# ── Always: update shared scripts ─────────────────────────────────────────────

log "Updating shared scripts..."
mkdir -p "$DRAFT_DIR/scripts"
curl -fsSL "$GITHUB_RAW/scripts/draft-update-check.sh" -o "$DRAFT_DIR/scripts/draft-update-check.sh"
curl -fsSL "$GITHUB_RAW/scripts/draft-update.sh" -o "$DRAFT_DIR/scripts/draft-update.sh"
chmod +x "$DRAFT_DIR/scripts/"*.sh
log "  Shared scripts updated at ~/.draft/scripts/"

# ── Codex: update if installed ────────────────────────────────────────────────

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
if [ -f "$CODEX_HOME/agents/draft-researcher.toml" ]; then
    log "Codex install detected — updating..."
    curl -fsSL "$GITHUB_RAW/scripts/inject-context.sh" -o "$CODEX_HOME/hooks/draft/inject-context.sh"
    chmod +x "$CODEX_HOME/hooks/draft/inject-context.sh"
    for agent in draft-researcher draft-executor draft-learner; do
        curl -fsSL "$GITHUB_RAW/.codex/agents/$agent.toml" -o "$CODEX_HOME/agents/$agent.toml"
    done
    curl -fsSL "$GITHUB_RAW/.codex/AGENTS.md" -o "$CODEX_HOME/AGENTS.md"
    USER_SKILLS="$HOME/.agents/skills"
    for skill in draft-setup draft-learn draft-update; do
        if [ -d "$USER_SKILLS/$skill" ]; then
            curl -fsSL "$GITHUB_RAW/skills/$skill/SKILL.md" -o "$USER_SKILLS/$skill/SKILL.md"
            log "  Updated $skill skill."
        fi
    done
    log "  Codex files updated."
fi

# ── Cursor: update if installed ───────────────────────────────────────────────

CURSOR_HOME="${CURSOR_HOME:-$HOME/.cursor}"
if [ -f "$CURSOR_HOME/hooks/draft/cursor-session-start.sh" ]; then
    log "Cursor install detected — updating..."
    curl -fsSL "$GITHUB_RAW/scripts/cursor-session-start.sh" \
        -o "$CURSOR_HOME/hooks/draft/cursor-session-start.sh"
    chmod +x "$CURSOR_HOME/hooks/draft/cursor-session-start.sh"
    if [ -f "$CURSOR_HOME/rules/draft-context.mdc" ]; then
        curl -fsSL "$GITHUB_RAW/.cursor/rules/draft-context.mdc" \
            -o "$CURSOR_HOME/rules/draft-context.mdc"
    fi
    for agent in draft-researcher draft-executor draft-learner; do
        if [ -f "$CURSOR_HOME/agents/$agent.md" ]; then
            curl -fsSL "$GITHUB_RAW/agents/$agent.md" -o "$CURSOR_HOME/agents/$agent.md"
        fi
    done
    for skill in draft-setup draft-learn draft-update; do
        if [ -d "$CURSOR_HOME/skills/$skill" ]; then
            curl -fsSL "$GITHUB_RAW/skills/$skill/SKILL.md" \
                -o "$CURSOR_HOME/skills/$skill/SKILL.md"
        fi
        if [ -d "$HOME/.agents/skills/$skill" ]; then
            curl -fsSL "$GITHUB_RAW/skills/$skill/SKILL.md" \
                -o "$HOME/.agents/skills/$skill/SKILL.md"
        fi
    done
    log "  Cursor files updated."
fi

# ── Claude Code note ──────────────────────────────────────────────────────────

warn "Claude Code: agent/skill files are managed by Anthropic's plugin system."
warn "  They will update when the latest plugin version is processed by the marketplace."

# ── Record new version and reset cache ───────────────────────────────────────

echo "$LATEST" > "$VERSION_FILE"
echo "UP_TO_DATE $LATEST" > "$LAST_CHECK_FILE"

echo ""
log "Draft updated to v$LATEST."
echo ""
echo "  Restart your session to apply changes."
echo ""
