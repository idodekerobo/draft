#!/bin/bash
# Draft — One-time Cursor setup
#
# End-user install (no local repo needed):
#   curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/main/scripts/cursor-setup.sh | bash
#
# Local development (from plugin repo root):
#   bash ./scripts/cursor-setup.sh
#
# What this does:
#   1. Creates ~/.draft/personal/ (global layer) and ~/.draft/workspaces/default/ (profile workspace)
#   2. Populates ~/.draft/shared/ (shared content dir — skills, agents, hooks)
#   3. Symlinks cursor-session-start.sh into ~/.cursor/hooks/draft/
#   4. Registers the sessionStart hook in ~/.cursor/hooks.json
#   5. [If no Claude Code or Codex] Symlinks draft-context.mdc to ~/.cursor/rules/
#   6. [If no Claude Code] Symlinks sub-agents from ~/.draft/shared/agents/md/ to ~/.cursor/agents/
#   7. Symlinks all Draft skills into ~/.agents/skills/ and ~/.cursor/skills/
#
# Skills and hook scripts are symlinks into ~/.draft/shared/ — a single update
# to shared/ propagates to Cursor automatically (no per-file re-download needed).
#
# Cursor reads ~/.claude/agents/ natively, so if Claude Code is already installed
# we skip agent install to avoid duplicates.
#
# After running: restart Cursor. Your product context is automatically injected
# into every new Composer session — no action needed.

set -euo pipefail

GITHUB_RAW="https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/main"
CURSOR_HOME="${CURSOR_HOME:-$HOME/.cursor}"
DRAFT_GLOBAL="$HOME/.draft"
DRAFT_WORKSPACE="$DRAFT_GLOBAL/workspaces/default"
SHARED_DIR="$DRAFT_GLOBAL/shared"
USER_AGENTS_SKILLS="$HOME/.agents/skills"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()   { echo -e "${GREEN}[Draft]${NC} $1"; }
warn()  { echo -e "${YELLOW}[Draft]${NC} $1"; }
err()   { echo -e "${RED}[Draft]${NC} $1" >&2; }
info()  { echo -e "${CYAN}[Draft]${NC} $1"; }

# ── Detect local vs remote source ─────────────────────────────────────────────
# BASH_SOURCE[0] is unset when piped via curl | bash.
SCRIPT_DIR=""
PLUGIN_ROOT=""
USE_LOCAL=false

if [ -n "${BASH_SOURCE[0]:-}" ]; then
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
    if [ -f "$PLUGIN_ROOT/scripts/cursor-session-start.sh" ]; then
        USE_LOCAL=true
    fi
fi

install_file() {
    local src_rel="$1"   # relative path within the plugin repo
    local dest="$2"       # absolute destination path

    if [ "$USE_LOCAL" = true ]; then
        cp "$PLUGIN_ROOT/$src_rel" "$dest"
    else
        curl -fsSL "$GITHUB_RAW/$src_rel" -o "$dest"
    fi
}

# Create a file symlink: target → link.
# Removes existing regular files (old copy-based installs) before symlinking.
symlink_file() {
    local target="$1"
    local link="$2"
    mkdir -p "$(dirname "$link")"
    if [ -e "$link" ] && [ ! -L "$link" ]; then rm -f "$link"; fi
    ln -sfn "$target" "$link"
}

# Create a directory symlink: target → link.
# Removes existing regular directories (old copy-based installs) before symlinking.
symlink_dir() {
    local target="$1"
    local link="$2"
    mkdir -p "$(dirname "$link")"
    if [ -d "$link" ] && [ ! -L "$link" ]; then rm -rf "$link"; fi
    ln -sfn "$target" "$link"
}

# ── Detect existing Draft installations ────────────────────────────────────────
# Cursor reads ~/.claude/agents/ and ~/.codex/AGENTS.md natively. If either
# plugin is installed, the shared context layer instructions and subagents are already
# flowing into Cursor — installing them again creates duplicate context blocks.

CLAUDE_CODE_INSTALLED=false
CODEX_INSTALLED=false

if [ -f "$HOME/.claude/agents/pm-agent.md" ]; then
    CLAUDE_CODE_INSTALLED=true
fi

if [ -f "$HOME/.codex/AGENTS.md" ]; then
    CODEX_INSTALLED=true
fi

# Require python3
if ! command -v python3 &>/dev/null; then
    err "python3 is required but not found. Install it and re-run."
    exit 1
fi

echo ""
if [ "$USE_LOCAL" = true ]; then
    log "Setting up Draft for Cursor (local source: $PLUGIN_ROOT)..."
else
    log "Setting up Draft for Cursor (source: GitHub main)..."
fi

if [ "$CLAUDE_CODE_INSTALLED" = true ]; then
    info "Claude Code plugin detected — skipping rules + subagent install (already provided)."
elif [ "$CODEX_INSTALLED" = true ]; then
    info "Codex plugin detected — skipping rules install (AGENTS.md already provided)."
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

# ── 2. Populate ~/.draft/shared/ ───────────────────────────────────────────────
# All skill/agent/hook symlinks point into this directory. One update here
# propagates to every tool instantly — no per-file re-downloads needed.

if [ "$USE_LOCAL" = true ]; then
    log "Populating ~/.draft/shared/ from local repo..."
    bash "$SCRIPT_DIR/populate-shared.sh"
else
    log "Populating ~/.draft/shared/ from GitHub..."
    USE_LOCAL=false GITHUB_RAW="$GITHUB_RAW" bash <(curl -fsSL "$GITHUB_RAW/scripts/populate-shared.sh")
fi

# ── 3. Symlink cursor-session-start.sh into ~/.cursor/hooks/draft/ ─────────────
# Always installed regardless of other plugins — Cursor needs its own
# sessionStart hook for workspace context injection.

log "Symlinking cursor-session-start hook script..."
mkdir -p "$CURSOR_HOME/hooks/draft"
symlink_file "$SHARED_DIR/hooks/cursor-session-start.sh" "$CURSOR_HOME/hooks/draft/cursor-session-start.sh"
log "Hook script symlinked to $CURSOR_HOME/hooks/draft/cursor-session-start.sh"

# ── 4. Register sessionStart hook in ~/.cursor/hooks.json ─────────────────────

log "Registering sessionStart hook..."

python3 - <<PYEOF
import json, sys
from pathlib import Path

hooks_path = Path("$CURSOR_HOME/hooks.json")
hook_command = "bash $CURSOR_HOME/hooks/draft/cursor-session-start.sh"

if hooks_path.exists():
    try:
        data = json.loads(hooks_path.read_text())
    except Exception:
        data = {}
else:
    data = {}

data.setdefault("version", 1)
hooks = data.setdefault("hooks", {})
session_hooks = hooks.setdefault("sessionStart", [])

already = any(
    h.get("command") == hook_command
    for h in session_hooks
    if isinstance(h, dict)
)

if already:
    print("[Draft] sessionStart hook already registered — skipping.")
    sys.exit(0)

session_hooks.append({
    "command": hook_command,
    "timeout": 10,
    "statusMessage": "Loading Draft workspace context"
})

hooks_path.parent.mkdir(parents=True, exist_ok=True)
hooks_path.write_text(json.dumps(data, indent=2) + "\n")
print("[Draft] sessionStart hook registered in ~/.cursor/hooks.json")
PYEOF

# ── 5. Symlink draft-context.mdc — skip if Claude Code or Codex is installed ──
# Claude Code: ~/.claude/agents/ already gives Cursor the shared context layer.
# Codex: ~/.codex/AGENTS.md already gives Cursor the shared context layer.

if [ "$CLAUDE_CODE_INSTALLED" = true ] || [ "$CODEX_INSTALLED" = true ]; then
    warn "Skipping draft-context.mdc — shared context layer already loaded from existing plugin."
else
    log "Symlinking draft-context.mdc rules file..."
    mkdir -p "$CURSOR_HOME/rules"
    symlink_file "$SHARED_DIR/cursor-context.mdc" "$CURSOR_HOME/rules/draft-context.mdc"
    log "Rules file symlinked to $CURSOR_HOME/rules/draft-context.mdc"
fi

# ── 6. Symlink sub-agents — skip if Claude Code is installed ───────────────────
# Cursor reads ~/.claude/agents/ natively. If Claude Code is installed, the
# draft-researcher/executor/learner agents are already symlinked there.

if [ "$CLAUDE_CODE_INSTALLED" = true ]; then
    warn "Skipping sub-agent install — agents already available from Claude Code plugin."
else
    log "Symlinking sub-agent definitions..."
    mkdir -p "$CURSOR_HOME/agents"
    for agent_file in "$SHARED_DIR/agents/md/"*.md; do
        agent_name="$(basename "$agent_file")"
        symlink_file "$agent_file" "$CURSOR_HOME/agents/$agent_name"
        log "  Symlinked $agent_name"
    done
fi

# ── 7. Symlink all Draft skills into ~/.agents/skills/ and ~/.cursor/skills/ ───
#
# Codex/Cursor load skills from ~/.agents/skills/ for any repo.
# Cursor also reads $CURSOR_HOME/skills/. Both dirs get directory symlinks into
# ~/.draft/shared/skills/ — the same target, two entry points.
# All skills are symlinked (not just a subset), so stale drift cannot happen.

log "Symlinking Draft skills to $USER_AGENTS_SKILLS/..."
mkdir -p "$USER_AGENTS_SKILLS"
for skill_dir in "$SHARED_DIR/skills"/*/; do
    skill_name="$(basename "$skill_dir")"
    symlink_dir "$skill_dir" "$USER_AGENTS_SKILLS/$skill_name"
    log "  Symlinked $skill_name → ~/.agents/skills/"
done

log "Symlinking Draft skills to $CURSOR_HOME/skills/..."
mkdir -p "$CURSOR_HOME/skills"
for skill_dir in "$SHARED_DIR/skills"/*/; do
    skill_name="$(basename "$skill_dir")"
    symlink_dir "$skill_dir" "$CURSOR_HOME/skills/$skill_name"
    log "  Symlinked $skill_name → $CURSOR_HOME/skills/"
done

# ── 8. Install shared update scripts ──────────────────────────────────────────
# Installed to ~/.draft/scripts/ — these manage the update process itself and
# are NOT in ~/.draft/shared/. Always kept current.

log "Installing shared update scripts..."
mkdir -p "$HOME/.draft/scripts"
install_file "scripts/draft-update-check.sh" "$HOME/.draft/scripts/draft-update-check.sh"
install_file "scripts/draft-update.sh" "$HOME/.draft/scripts/draft-update.sh"
chmod +x "$HOME/.draft/scripts/"*.sh
log "  Scripts installed to ~/.draft/scripts/"

# ── 9. Record installed version ────────────────────────────────────────────────

log "Recording installed version..."
if [ "$USE_LOCAL" = true ]; then
    DRAFT_VERSION=$(cat "$PLUGIN_ROOT/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unknown")
else
    DRAFT_VERSION=$(curl -fsSL "$GITHUB_RAW/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "unknown")
fi
echo "$DRAFT_VERSION" > "$HOME/.draft/version"
log "  Version $DRAFT_VERSION recorded at ~/.draft/version"

# Register in global config.json — tools.cursor entry + plugin_version
python3 -c "
import json, pathlib, datetime
cfg_path = pathlib.Path('$HOME/.draft/config.json')
cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {'version': '1', 'tools': {}}
cfg.setdefault('tools', {})['cursor'] = {'added_at': datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')}
cfg['plugin_version'] = '$DRAFT_VERSION'
cfg_path.write_text(json.dumps(cfg, indent=2) + '\n')
" 2>/dev/null || true
log "  Registered cursor in ~/.draft/config.json"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
log "Setup complete."
echo ""
echo "  Next steps:"
echo "  1. Restart Cursor"
if [ "$CLAUDE_CODE_INSTALLED" = false ] && [ "$CODEX_INSTALLED" = false ]; then
    echo "  2. Run /draft-setup to initialize your shared context layer"
else
    echo "  2. Your existing context will load automatically"
fi
echo ""
echo "  How it works:"
echo "  Your product context is injected silently at the start of every"
echo "  new Cursor Composer session. No action needed — just open Composer"
echo "  and Draft already knows your product, priorities, and team."
echo ""
