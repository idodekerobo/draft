#!/bin/bash
# Draft — One-time Codex setup
#
# End-user install (no local repo needed):
#   curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/main/scripts/codex-setup.sh | bash
#
# Local development (from plugin repo root):
#   bash ./scripts/codex-setup.sh
#
# What this does:
#   1. Creates ~/.draft/personal/ (global layer) and ~/.draft/workspaces/default/ (profile workspace)
#   2. Installs inject-context.sh to ~/.codex/hooks/draft/
#   2b. Installs codex-session-end.sh to ~/.codex/hooks/draft/
#   3. Registers the SessionStart hook in ~/.codex/hooks.json
#   3b. Registers the Stop hook in ~/.codex/hooks.json
#   4. Enables the codex_hooks feature flag in ~/.codex/config.toml
#   5. Installs sub-agent TOML files to ~/.codex/agents/
#   6. Writes pm-agent instructions to ~/.codex/AGENTS.md
#   7. Installs draft:setup skill to ~/.agents/skills/ for $draft:setup invocation
#
# After running: restart Codex, then run /draft:setup to load your PM brain.

set -euo pipefail

GITHUB_RAW="https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/main"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
DRAFT_GLOBAL="$HOME/.draft"
DRAFT_WORKSPACE="$DRAFT_GLOBAL/workspaces/default"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[Draft]${NC} $1"; }
warn() { echo -e "${YELLOW}[Draft]${NC} $1"; }
err()  { echo -e "${RED}[Draft]${NC} $1" >&2; }

# Detect whether we're running from inside the plugin repo.
# BASH_SOURCE[0] is unset when piped via curl | bash, so we check for the
# plugin root's marker file relative to the script location.
SCRIPT_DIR=""
PLUGIN_ROOT=""
USE_LOCAL=false

if [ -n "${BASH_SOURCE[0]:-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    if [ -f "$PLUGIN_ROOT/.codex/AGENTS.md" ]; then
        USE_LOCAL=true
    fi
fi

install_file() {
    local src_rel="$1"   # relative path within the plugin (e.g. scripts/inject-context.sh)
    local dest="$2"       # absolute destination path

    if [ "$USE_LOCAL" = true ]; then
        cp "$PLUGIN_ROOT/$src_rel" "$dest"
    else
        curl -fsSL "$GITHUB_RAW/$src_rel" -o "$dest"
    fi
}

# Require python3
if ! command -v python3 &>/dev/null; then
    err "python3 is required but not found. Install it and re-run."
    exit 1
fi

echo ""
if [ "$USE_LOCAL" = true ]; then
    log "Setting up Draft for Codex (local source: $PLUGIN_ROOT)..."
else
    log "Setting up Draft for Codex (source: GitHub main)..."
fi
echo ""

# ── 1. Bootstrap workspace ─────────────────────────────────────────────────────
# Two layers: global personal (~/.draft/personal/) and per-profile workspace.
# Creating both separately so personal files are not inside any profile directory.

# 1a. Global personal layer (~/.draft/personal/)
if [ ! -d "$DRAFT_GLOBAL/personal" ]; then
    log "Creating global personal layer at $DRAFT_GLOBAL/personal..."

    mkdir -p \
        "$DRAFT_GLOBAL/personal/user" \
        "$DRAFT_GLOBAL/personal/wip"

    cat > "$DRAFT_GLOBAL/personal/user/index.md" <<'EOF'
---
name: user
description: >
  No information recorded yet.
last_updated: ""
source: ""
---
EOF

    cat > "$DRAFT_GLOBAL/personal/memory.md" <<'EOF'
---
name: memory
description: Vocabulary, working preferences, and non-obvious patterns.
last_updated: ""
source: ""
---

## Vocabulary

## Preferences

## Goals

## Patterns
EOF

    log "Global personal layer created at $DRAFT_GLOBAL/personal"
else
    warn "Global personal layer already exists at $DRAFT_GLOBAL/personal — skipping."
fi

# 1b. Default profile workspace (~/.draft/workspaces/default/)
if [ ! -d "$DRAFT_WORKSPACE" ]; then
    log "Creating default workspace at $DRAFT_WORKSPACE..."

    # Standard 4 context dimensions. Custom dims (e.g. context/customers/, context/architecture/)
    # can be added at any time — /draft:learn will create context/<dim>/log/ automatically via mkdir -p.
    mkdir -p \
        "$DRAFT_WORKSPACE/context/company/log" \
        "$DRAFT_WORKSPACE/context/product/log" \
        "$DRAFT_WORKSPACE/context/team/log" \
        "$DRAFT_WORKSPACE/context/priorities/log" \
        "$DRAFT_WORKSPACE/context/decisions" \
        "$DRAFT_WORKSPACE/docs" \
        "$DRAFT_WORKSPACE/config"

    for dim in company product team priorities; do
        cat > "$DRAFT_WORKSPACE/context/$dim/index.md" <<EOF
---
name: $dim
description: >
  No information recorded yet.
last_updated: ""
source: ""
---
EOF
    done

    cat > "$DRAFT_WORKSPACE/context/tensions.md" <<'EOF'
# Tensions

Active contradictions and inconsistencies noticed across context dimensions.
EOF

    log "Default workspace created at $DRAFT_WORKSPACE"
else
    warn "Default workspace already exists at $DRAFT_WORKSPACE — skipping creation."
fi

# 1c. Set active-profile to "default" if not already set
if [ ! -f "$DRAFT_GLOBAL/active-profile" ]; then
    echo "default" > "$DRAFT_GLOBAL/active-profile"
    log "Active profile set to: default"
fi

# ── 2. Install hook scripts ────────────────────────────────────────────────────

log "Installing inject-context hook script..."
mkdir -p "$CODEX_HOME/hooks/draft"
install_file "scripts/inject-context.sh" "$CODEX_HOME/hooks/draft/inject-context.sh"
chmod +x "$CODEX_HOME/hooks/draft/inject-context.sh"
log "Hook script installed to $CODEX_HOME/hooks/draft/inject-context.sh"

# ── 2b. Install codex-session-end hook script ──────────────────────────────────

log "Installing codex-session-end hook script..."
install_file "scripts/codex-session-end.sh" "$CODEX_HOME/hooks/draft/codex-session-end.sh"
chmod +x "$CODEX_HOME/hooks/draft/codex-session-end.sh"
log "Hook script installed to $CODEX_HOME/hooks/draft/codex-session-end.sh"

# ── 3. Register SessionStart hook in ~/.codex/hooks.json ──────────────────────

log "Registering SessionStart hook..."

python3 - <<PYEOF
import json, sys
from pathlib import Path

hooks_path = Path("$CODEX_HOME/hooks.json")
hook_command = "bash $CODEX_HOME/hooks/draft/inject-context.sh"

if hooks_path.exists():
    try:
        data = json.loads(hooks_path.read_text())
    except Exception:
        data = {}
else:
    data = {}

hooks = data.setdefault("hooks", {})
session_hooks = hooks.setdefault("SessionStart", [])

already = any(
    any(h.get("command") == hook_command for h in group.get("hooks", []))
    for group in session_hooks
    if isinstance(group, dict)
)

if already:
    print("[Draft] Hook already registered — skipping.")
    sys.exit(0)

session_hooks.append({
    "matcher": "startup|resume",
    "hooks": [
        {
            "type": "command",
            "command": hook_command,
            "statusMessage": "Loading Draft workspace context"
        }
    ]
})

hooks_path.parent.mkdir(parents=True, exist_ok=True)
hooks_path.write_text(json.dumps(data, indent=2) + "\n")
print("[Draft] Hook registered in ~/.codex/hooks.json")
PYEOF

# ── 3b. Register Stop hook in ~/.codex/hooks.json ─────────────────────────────

log "Registering Stop hook..."

python3 - <<PYEOF
import json, sys
from pathlib import Path

hooks_path = Path("$CODEX_HOME/hooks.json")
hook_command = "bash $CODEX_HOME/hooks/draft/codex-session-end.sh"

if hooks_path.exists():
    try:
        data = json.loads(hooks_path.read_text())
    except Exception:
        data = {}
else:
    data = {}

hooks = data.setdefault("hooks", {})
stop_hooks = hooks.setdefault("Stop", [])

already = any(
    any(h.get("command") == hook_command for h in group.get("hooks", []))
    for group in stop_hooks
    if isinstance(group, dict)
)

if already:
    print("[Draft] Stop hook already registered — skipping.")
    sys.exit(0)

stop_hooks.append({
    "hooks": [
        {
            "type": "command",
            "command": hook_command,
            "timeout": 30,
            "statusMessage": "Saving Draft session state"
        }
    ]
})

hooks_path.parent.mkdir(parents=True, exist_ok=True)
hooks_path.write_text(json.dumps(data, indent=2) + "\n")
print("[Draft] Stop hook registered in ~/.codex/hooks.json")
PYEOF

# ── 4. Enable hooks feature flag in ~/.codex/config.toml ──────────────────────

log "Enabling codex_hooks feature flag..."

python3 - <<PYEOF
import re
from pathlib import Path

config_path = Path("$CODEX_HOME/config.toml")
content = config_path.read_text() if config_path.exists() else ""

if "codex_hooks" in content:
    print("[Draft] codex_hooks already set — skipping.")
elif "[features]" in content:
    content = re.sub(
        r'(\[features\][^\[]*)',
        r'\1codex_hooks = true\n',
        content,
        count=1,
        flags=re.DOTALL
    )
    config_path.write_text(content)
    print("[Draft] Added codex_hooks = true to existing [features] block.")
else:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(content + "\n[features]\ncodex_hooks = true\n")
    print("[Draft] Added [features] block with codex_hooks = true.")
PYEOF

# ── 5. Install sub-agent TOML files ───────────────────────────────────────────

log "Installing sub-agent definitions..."
mkdir -p "$CODEX_HOME/agents"

for agent in draft-researcher draft-executor draft-learner; do
    install_file ".codex/agents/$agent.toml" "$CODEX_HOME/agents/$agent.toml"
    log "  Installed $agent.toml"
done

# ── 6. Write pm-agent instructions to ~/.codex/AGENTS.md ──────────────────────

log "Writing pm-agent instructions to ~/.codex/AGENTS.md..."

if [ -f "$CODEX_HOME/AGENTS.md" ]; then
    warn "~/.codex/AGENTS.md already exists — backing up to ~/.codex/AGENTS.md.bak"
    cp "$CODEX_HOME/AGENTS.md" "$CODEX_HOME/AGENTS.md.bak"
fi

install_file ".codex/AGENTS.md" "$CODEX_HOME/AGENTS.md"
log "AGENTS.md written."

# ── 7. Install Draft skill to user-level skills directory ─────────────────────
#
# Codex loads skills from ~/.agents/skills/ for any repo/directory.
# Installing here makes $draft:setup available everywhere without plugins.

USER_SKILLS_DIR="$HOME/.agents/skills"

log "Installing draft:setup skill..."
mkdir -p "$USER_SKILLS_DIR/draft-setup"
install_file "skills/draft-setup/SKILL.md" "$USER_SKILLS_DIR/draft-setup/SKILL.md"
log "  Skill installed to $USER_SKILLS_DIR/draft-setup/SKILL.md"

log "Installing draft:learn skill..."
mkdir -p "$USER_SKILLS_DIR/draft-learn"
install_file "skills/draft-learn/SKILL.md" "$USER_SKILLS_DIR/draft-learn/SKILL.md"
log "  Skill installed to $USER_SKILLS_DIR/draft-learn/SKILL.md"

log "Installing draft:setup-collab skill..."
mkdir -p "$USER_SKILLS_DIR/draft-setup-collab"
install_file "skills/draft-setup-collab/SKILL.md" "$USER_SKILLS_DIR/draft-setup-collab/SKILL.md"
log "  Skill installed to $USER_SKILLS_DIR/draft-setup-collab/SKILL.md"

log "Installing draft:publish-team skill..."
mkdir -p "$USER_SKILLS_DIR/draft-publish-team"
install_file "skills/draft-publish-team/SKILL.md" "$USER_SKILLS_DIR/draft-publish-team/SKILL.md"
log "  Skill installed to $USER_SKILLS_DIR/draft-publish-team/SKILL.md"

log "Installing draft:load-team skill..."
mkdir -p "$USER_SKILLS_DIR/draft-load-team"
install_file "skills/draft-load-team/SKILL.md" "$USER_SKILLS_DIR/draft-load-team/SKILL.md"
log "  Skill installed to $USER_SKILLS_DIR/draft-load-team/SKILL.md"

log "Installing draft:switch skill..."
mkdir -p "$USER_SKILLS_DIR/draft-switch"
install_file "skills/draft-switch/SKILL.md" "$USER_SKILLS_DIR/draft-switch/SKILL.md"
log "  Skill installed to $USER_SKILLS_DIR/draft-switch/SKILL.md"

log "Installing draft:profiles skill..."
mkdir -p "$USER_SKILLS_DIR/draft-profiles"
install_file "skills/draft-profiles/SKILL.md" "$USER_SKILLS_DIR/draft-profiles/SKILL.md"
log "  Skill installed to $USER_SKILLS_DIR/draft-profiles/SKILL.md"

# ── 8. Install shared update scripts ──────────────────────────────────────────
# Installed to ~/.draft/scripts/ — accessible from all platforms (Codex, Cursor, Claude Code).

log "Installing shared update scripts..."
mkdir -p "$HOME/.draft/scripts"
install_file "scripts/draft-update-check.sh" "$HOME/.draft/scripts/draft-update-check.sh"
install_file "scripts/draft-update.sh" "$HOME/.draft/scripts/draft-update.sh"
chmod +x "$HOME/.draft/scripts/"*.sh
log "  Scripts installed to ~/.draft/scripts/"

# ── 9. Install draft:update skill ─────────────────────────────────────────────

log "Installing draft:update skill..."
mkdir -p "$USER_SKILLS_DIR/draft-update"
install_file "skills/draft-update/SKILL.md" "$USER_SKILLS_DIR/draft-update/SKILL.md"
log "  Skill installed to $USER_SKILLS_DIR/draft-update/SKILL.md"

# ── 10. Record installed version ───────────────────────────────────────────────

log "Recording installed version..."
if [ "$USE_LOCAL" = true ]; then
    DRAFT_VERSION=$(cat "$PLUGIN_ROOT/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unknown")
else
    DRAFT_VERSION=$(curl -fsSL "$GITHUB_RAW/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unknown")
fi
echo "$DRAFT_VERSION" > "$HOME/.draft/version"
log "  Version $DRAFT_VERSION recorded at ~/.draft/version"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
log "Setup complete."
echo ""
echo "  Next steps:"
echo "  1. Restart Codex"
echo "  2. Type \$draft:setup to initialize your PM brain"
echo ""
