#!/bin/bash
# Draft — Codex uninstall
#
# Reverses every step performed by codex-setup.sh:
#   1. Removes the SessionStart hook entry from ~/.codex/hooks.json
#   1b. Removes the Stop hook entry from ~/.codex/hooks.json
#   2. Removes hook scripts at ~/.codex/hooks/draft/
#   3. Removes sub-agent TOML files from ~/.codex/agents/
#   4. Removes (or restores) ~/.codex/AGENTS.md
#   5. Removes the draft:setup skill from ~/.agents/skills/setup/
#
# Does NOT touch ~/.draft/workspace/ (your shared context layer data stays intact)
# Does NOT remove codex_hooks = true from config.toml (harmless Codex feature flag)

set -euo pipefail

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
USER_SKILL_DIR="$HOME/.agents/skills/draft-setup"
USER_LEARN_SKILL_DIR="$HOME/.agents/skills/draft-learn"
USER_UPDATE_SKILL_DIR="$HOME/.agents/skills/draft-update"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[Draft uninstall]${NC} $1"; }
warn() { echo -e "${YELLOW}[Draft uninstall]${NC} $1"; }

echo ""
log "Uninstalling Draft from Codex..."
echo ""

# ── 1. Remove SessionStart hook from ~/.codex/hooks.json ──────────────────────

log "Removing SessionStart hook from $CODEX_HOME/hooks.json..."

python3 - <<PYEOF
import json, sys
from pathlib import Path

hooks_path = Path("$CODEX_HOME/hooks.json")
hook_command = "bash $CODEX_HOME/hooks/draft/inject-context.sh"

if not hooks_path.exists():
    print("[Draft uninstall] hooks.json not found — skipping.")
    sys.exit(0)

try:
    data = json.loads(hooks_path.read_text())
except Exception:
    print("[Draft uninstall] hooks.json unreadable — skipping.")
    sys.exit(0)

hooks = data.get("hooks", {})
session_hooks = hooks.get("SessionStart", [])

original_len = len(session_hooks)
filtered = [
    group for group in session_hooks
    if not (
        isinstance(group, dict) and
        any(h.get("command") == hook_command for h in group.get("hooks", []))
    )
]

if len(filtered) == original_len:
    print("[Draft uninstall] Hook not found in hooks.json — skipping.")
else:
    hooks["SessionStart"] = filtered
    if not filtered:
        del hooks["SessionStart"]
    if not hooks:
        del data["hooks"]
    hooks_path.write_text(json.dumps(data, indent=2) + "\n")
    print("[Draft uninstall] Hook removed from hooks.json.")
PYEOF

# ── 1b. Remove Stop hook from ~/.codex/hooks.json ─────────────────────────────

log "Removing Stop hook from $CODEX_HOME/hooks.json..."

python3 - <<PYEOF
import json, sys
from pathlib import Path

hooks_path = Path("$CODEX_HOME/hooks.json")
hook_command = "bash $CODEX_HOME/hooks/draft/codex-session-end.sh"

if not hooks_path.exists():
    print("[Draft uninstall] hooks.json not found — skipping.")
    sys.exit(0)

try:
    data = json.loads(hooks_path.read_text())
except Exception:
    print("[Draft uninstall] hooks.json unreadable — skipping.")
    sys.exit(0)

hooks = data.get("hooks", {})
stop_hooks = hooks.get("Stop", [])

original_len = len(stop_hooks)
filtered = [
    group for group in stop_hooks
    if not (
        isinstance(group, dict) and
        any(h.get("command") == hook_command for h in group.get("hooks", []))
    )
]

if len(filtered) == original_len:
    print("[Draft uninstall] Stop hook not found in hooks.json — skipping.")
else:
    hooks["Stop"] = filtered
    if not filtered:
        del hooks["Stop"]
    if not hooks:
        del data["hooks"]
    hooks_path.write_text(json.dumps(data, indent=2) + "\n")
    print("[Draft uninstall] Stop hook removed from hooks.json.")
PYEOF

# ── 2. Remove hook script ──────────────────────────────────────────────────────

if [ -f "$CODEX_HOME/hooks/draft/inject-context.sh" ]; then
    rm -f "$CODEX_HOME/hooks/draft/inject-context.sh"
    log "Removed inject-context.sh"
else
    warn "inject-context.sh not found — skipping."
fi

if [ -f "$CODEX_HOME/hooks/draft/codex-session-end.sh" ]; then
    rm -f "$CODEX_HOME/hooks/draft/codex-session-end.sh"
    log "Removed codex-session-end.sh"
fi

rmdir "$CODEX_HOME/hooks/draft" 2>/dev/null && log "Removed empty hooks/draft/ directory" || true
rmdir "$CODEX_HOME/hooks" 2>/dev/null && log "Removed empty hooks/ directory" || true

# ── 3. Remove sub-agent TOML files ────────────────────────────────────────────

for agent in draft-researcher draft-executor draft-learner; do
    toml="$CODEX_HOME/agents/$agent.toml"
    if [ -f "$toml" ]; then
        rm -f "$toml"
        log "Removed $agent.toml"
    else
        warn "$agent.toml not found — skipping."
    fi
done

# ── 4. Remove or restore AGENTS.md ────────────────────────────────────────────

if [ -f "$CODEX_HOME/AGENTS.md.bak" ]; then
    mv "$CODEX_HOME/AGENTS.md.bak" "$CODEX_HOME/AGENTS.md"
    log "Restored AGENTS.md from backup."
elif [ -f "$CODEX_HOME/AGENTS.md" ]; then
    rm -f "$CODEX_HOME/AGENTS.md"
    log "Removed AGENTS.md (no backup found)."
else
    warn "AGENTS.md not found — skipping."
fi

# ── 5. Remove Draft skills ─────────────────────────────────────────────────────

if [ -d "$USER_SKILL_DIR" ]; then
    rm -rf "$USER_SKILL_DIR"
    log "Removed skill at $USER_SKILL_DIR"
else
    warn "Skill not found at $USER_SKILL_DIR — skipping."
fi

if [ -d "$USER_LEARN_SKILL_DIR" ]; then
    rm -rf "$USER_LEARN_SKILL_DIR"
    log "Removed skill at $USER_LEARN_SKILL_DIR"
else
    warn "Skill not found at $USER_LEARN_SKILL_DIR — skipping."
fi

if [ -d "$USER_UPDATE_SKILL_DIR" ]; then
    rm -rf "$USER_UPDATE_SKILL_DIR"
    log "Removed skill at $USER_UPDATE_SKILL_DIR"
else
    warn "Skill not found at $USER_UPDATE_SKILL_DIR — skipping."
fi

rmdir "$HOME/.agents/skills" 2>/dev/null || true
rmdir "$HOME/.agents" 2>/dev/null || true

# ── Remove shared scripts (only if Cursor is not also installed) ───────────────

if [ ! -f "$HOME/.cursor/hooks/draft/cursor-session-start.sh" ]; then
    if [ -d "$HOME/.draft/scripts" ]; then
        rm -rf "$HOME/.draft/scripts"
        log "Removed ~/.draft/scripts/"
    fi
    if [ -f "$HOME/.draft/last-update-check" ]; then
        rm -f "$HOME/.draft/last-update-check"
        log "Removed ~/.draft/last-update-check"
    fi
else
    warn "Cursor install detected — keeping ~/.draft/scripts/ and ~/.draft/last-update-check."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
log "Uninstall complete."
echo ""
echo "  What was removed:"
echo "    ~/.codex/hooks/draft/inject-context.sh"
echo "    ~/.codex/hooks/draft/codex-session-end.sh"
echo "    ~/.codex/hooks.json  (Draft entries only)"
echo "    ~/.codex/agents/draft-{researcher,executor,learner}.toml"
echo "    ~/.codex/AGENTS.md"
echo "    ~/.agents/skills/draft-setup/  (\$draft-setup skill)"
echo "    ~/.agents/skills/draft-learn/  (\$draft-learn skill)"
echo ""
echo "  What was kept:"
echo "    ~/.draft/workspace/  (your shared context layer data is untouched)"
echo "    ~/.codex/config.toml (left codex_hooks in place)"
echo ""
