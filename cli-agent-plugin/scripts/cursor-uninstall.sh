#!/bin/bash
# Draft — Cursor uninstall
#
# Reverses every step performed by cursor-setup.sh:
#   1. Removes the sessionStart hook entry from ~/.cursor/hooks.json
#   2. Removes the hook script at ~/.cursor/hooks/draft/
#   3. Removes draft-context.mdc from ~/.cursor/rules/
#   4. Removes the draft-setup skill from ~/.cursor/skills/ and ~/.agents/skills/
#
# Does NOT touch ~/.draft/workspace/ (your PM brain data stays intact)

set -euo pipefail

CURSOR_HOME="${CURSOR_HOME:-$HOME/.cursor}"
CURSOR_SKILL_DIR="$CURSOR_HOME/skills/draft-setup"
AGENTS_SKILL_DIR="$HOME/.agents/skills/draft-setup"
CURSOR_LEARN_SKILL_DIR="$CURSOR_HOME/skills/draft-learn"
AGENTS_LEARN_SKILL_DIR="$HOME/.agents/skills/draft-learn"
CURSOR_UPDATE_SKILL_DIR="$CURSOR_HOME/skills/draft-update"
AGENTS_UPDATE_SKILL_DIR="$HOME/.agents/skills/draft-update"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[Draft uninstall]${NC} $1"; }
warn() { echo -e "${YELLOW}[Draft uninstall]${NC} $1"; }

echo ""
log "Uninstalling Draft from Cursor..."
echo ""

# ── 1. Remove sessionStart hook from ~/.cursor/hooks.json ─────────────────────

log "Removing sessionStart hook from $CURSOR_HOME/hooks.json..."

python3 - <<PYEOF
import json, sys
from pathlib import Path

hooks_path = Path("$CURSOR_HOME/hooks.json")
hook_command = "bash $CURSOR_HOME/hooks/draft/cursor-session-start.sh"

if not hooks_path.exists():
    print("[Draft uninstall] hooks.json not found — skipping.")
    sys.exit(0)

try:
    data = json.loads(hooks_path.read_text())
except Exception:
    print("[Draft uninstall] hooks.json unreadable — skipping.")
    sys.exit(0)

hooks = data.get("hooks", {})
session_hooks = hooks.get("sessionStart", [])

original_len = len(session_hooks)
filtered = [
    h for h in session_hooks
    if not (isinstance(h, dict) and h.get("command") == hook_command)
]

if len(filtered) == original_len:
    print("[Draft uninstall] Hook not found in hooks.json — skipping.")
else:
    hooks["sessionStart"] = filtered
    if not filtered:
        del hooks["sessionStart"]
    if not hooks:
        del data["hooks"]
    hooks_path.write_text(json.dumps(data, indent=2) + "\n")
    print("[Draft uninstall] Hook removed from hooks.json.")
PYEOF

# ── 2. Remove hook script ──────────────────────────────────────────────────────

if [ -f "$CURSOR_HOME/hooks/draft/cursor-session-start.sh" ]; then
    rm -f "$CURSOR_HOME/hooks/draft/cursor-session-start.sh"
    log "Removed cursor-session-start.sh"
    rmdir "$CURSOR_HOME/hooks/draft" 2>/dev/null && log "Removed empty hooks/draft/ directory" || true
    rmdir "$CURSOR_HOME/hooks" 2>/dev/null && log "Removed empty hooks/ directory" || true
else
    warn "cursor-session-start.sh not found — skipping."
fi

# ── 3. Remove draft-context.mdc rules file ────────────────────────────────────

if [ -f "$CURSOR_HOME/rules/draft-context.mdc" ]; then
    rm -f "$CURSOR_HOME/rules/draft-context.mdc"
    log "Removed draft-context.mdc"
    rmdir "$CURSOR_HOME/rules" 2>/dev/null || true
else
    warn "draft-context.mdc not found — skipping."
fi

# ── 4. Remove sub-agent definitions ───────────────────────────────────────────

for agent in draft-researcher draft-executor draft-learner; do
    agent_file="$CURSOR_HOME/agents/$agent.md"
    if [ -f "$agent_file" ]; then
        rm -f "$agent_file"
        log "Removed $agent.md"
    else
        warn "$agent.md not found — skipping."
    fi
done
rmdir "$CURSOR_HOME/agents" 2>/dev/null || true

# ── 5. Remove Draft skills ─────────────────────────────────────────────────────

if [ -d "$CURSOR_SKILL_DIR" ]; then
    rm -rf "$CURSOR_SKILL_DIR"
    log "Removed skill at $CURSOR_SKILL_DIR"
else
    warn "Skill not found at $CURSOR_SKILL_DIR — skipping."
fi

if [ -d "$CURSOR_LEARN_SKILL_DIR" ]; then
    rm -rf "$CURSOR_LEARN_SKILL_DIR"
    log "Removed skill at $CURSOR_LEARN_SKILL_DIR"
else
    warn "Skill not found at $CURSOR_LEARN_SKILL_DIR — skipping."
fi

rmdir "$CURSOR_HOME/skills" 2>/dev/null || true

if [ -d "$AGENTS_SKILL_DIR" ]; then
    rm -rf "$AGENTS_SKILL_DIR"
    log "Removed skill at $AGENTS_SKILL_DIR"
else
    warn "Skill not found at $AGENTS_SKILL_DIR — skipping."
fi

if [ -d "$AGENTS_LEARN_SKILL_DIR" ]; then
    rm -rf "$AGENTS_LEARN_SKILL_DIR"
    log "Removed skill at $AGENTS_LEARN_SKILL_DIR"
else
    warn "Skill not found at $AGENTS_LEARN_SKILL_DIR — skipping."
fi

if [ -d "$CURSOR_UPDATE_SKILL_DIR" ]; then
    rm -rf "$CURSOR_UPDATE_SKILL_DIR"
    log "Removed skill at $CURSOR_UPDATE_SKILL_DIR"
else
    warn "Skill not found at $CURSOR_UPDATE_SKILL_DIR — skipping."
fi

if [ -d "$AGENTS_UPDATE_SKILL_DIR" ]; then
    rm -rf "$AGENTS_UPDATE_SKILL_DIR"
    log "Removed skill at $AGENTS_UPDATE_SKILL_DIR"
else
    warn "Skill not found at $AGENTS_UPDATE_SKILL_DIR — skipping."
fi

rmdir "$HOME/.agents/skills" 2>/dev/null || true
rmdir "$HOME/.agents" 2>/dev/null || true

# ── Remove shared scripts (only if Codex is not also installed) ────────────────

if [ ! -f "$HOME/.codex/agents/draft-researcher.toml" ]; then
    if [ -d "$HOME/.draft/scripts" ]; then
        rm -rf "$HOME/.draft/scripts"
        log "Removed ~/.draft/scripts/"
    fi
    if [ -f "$HOME/.draft/last-update-check" ]; then
        rm -f "$HOME/.draft/last-update-check"
        log "Removed ~/.draft/last-update-check"
    fi
else
    warn "Codex install detected — keeping ~/.draft/scripts/ and ~/.draft/last-update-check."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
log "Uninstall complete."
echo ""
echo "  What was removed:"
echo "    ~/.cursor/hooks/draft/cursor-session-start.sh"
echo "    ~/.cursor/hooks.json  (Draft entry only)"
echo "    ~/.cursor/rules/draft-context.mdc"
echo "    ~/.cursor/agents/draft-{researcher,executor,learner}.md"
echo "    ~/.cursor/skills/draft-setup/  (/draft-setup skill)"
echo "    ~/.cursor/skills/draft-learn/  (/draft-learn skill)"
echo "    ~/.agents/skills/draft-setup/"
echo "    ~/.agents/skills/draft-learn/"
echo ""
echo "  What was kept:"
echo "    ~/.draft/workspace/  (your PM brain data is untouched)"
echo ""
