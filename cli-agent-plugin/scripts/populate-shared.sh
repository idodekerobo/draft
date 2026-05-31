#!/bin/bash
# populate-shared.sh — copy plugin content to ~/.draft/shared/
#
# Shared helper called by:
#   draft add <tool>  (via add.ts → bash populate-shared.sh)
#   codex-setup.sh    (local install path — USE_LOCAL=true)
#   cursor-setup.sh   (local install path — USE_LOCAL=true)
#   draft-update.sh   (called from extracted tarball in /tmp/)
#
# LOCAL mode:  resolves PLUGIN_ROOT from this script's location (BASH_SOURCE).
#              Works when called via `bash /path/to/populate-shared.sh`.
# REMOTE mode: set USE_LOCAL=false before calling; downloads from GITHUB_RAW.
#              Used by codex-setup.sh / cursor-setup.sh in curl|bash installs.
#
# After this script runs, tool setup scripts symlink from their tool-specific
# config dirs into ~/.draft/shared/ instead of copying files individually.
# All tools share the same source files — one update propagates everywhere.

set -euo pipefail

SHARED="$HOME/.draft/shared"
GITHUB_RAW="${GITHUB_RAW:-https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/main}"

# ── Detect local vs remote ─────────────────────────────────────────────────────
# USE_LOCAL may be pre-set by a calling script. If not, auto-detect.

if [ -z "${USE_LOCAL:-}" ]; then
    if [ -n "${PLUGIN_ROOT:-}" ] && [ -f "$PLUGIN_ROOT/skills/draft-setup/SKILL.md" ]; then
        USE_LOCAL=true
    elif [ -n "${BASH_SOURCE[0]:-}" ]; then
        _SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
        _PLUGIN_ROOT="$(cd "$_SCRIPT_DIR/.." && pwd)"
        if [ -f "$_PLUGIN_ROOT/skills/draft-setup/SKILL.md" ]; then
            USE_LOCAL=true
            PLUGIN_ROOT="$_PLUGIN_ROOT"
        else
            USE_LOCAL=false
        fi
    else
        USE_LOCAL=false
    fi
fi

# ── Helpers ────────────────────────────────────────────────────────────────────

# Copy or download a single file
fetch_file() {
    local src_rel="$1"   # relative path within plugin repo
    local dst="$2"        # absolute destination path
    mkdir -p "$(dirname "$dst")"
    if [ "$USE_LOCAL" = true ]; then
        cp "$PLUGIN_ROOT/$src_rel" "$dst"
    else
        curl -fsSL "$GITHUB_RAW/$src_rel" -o "$dst"
    fi
}

echo "[Draft] Populating ~/.draft/shared/..."
mkdir -p \
    "$SHARED/skills" \
    "$SHARED/agents/md" \
    "$SHARED/agents/toml" \
    "$SHARED/hooks"

# ── Skills ─────────────────────────────────────────────────────────────────────
# Overwrite in place — existing symlinks to skill subdirs remain valid because
# the target directory path is preserved; only its contents are updated.

if [ "$USE_LOCAL" = true ]; then
    cp -r "$PLUGIN_ROOT/skills/." "$SHARED/skills/"
else
    # Remote: download each skill's SKILL.md individually.
    # Flat skills:
    for skill in \
        draft-compact \
        draft-learn \
        draft-load-team \
        draft-profiles \
        draft-publish-team \
        draft-setup \
        draft-setup-collab \
        draft-switch \
        draft-synthesize \
        draft-update
    do
        mkdir -p "$SHARED/skills/$skill"
        curl -fsSL "$GITHUB_RAW/skills/$skill/SKILL.md" -o "$SHARED/skills/$skill/SKILL.md"
    done
    # draft-connect has subdirectories
    mkdir -p \
        "$SHARED/skills/draft-connect/github" \
        "$SHARED/skills/draft-connect/granola" \
        "$SHARED/skills/draft-connect/slack"
    curl -fsSL "$GITHUB_RAW/skills/draft-connect/SKILL.md"          -o "$SHARED/skills/draft-connect/SKILL.md"
    curl -fsSL "$GITHUB_RAW/skills/draft-connect/github/SKILL.md"   -o "$SHARED/skills/draft-connect/github/SKILL.md"
    curl -fsSL "$GITHUB_RAW/skills/draft-connect/granola/SKILL.md"  -o "$SHARED/skills/draft-connect/granola/SKILL.md"
    curl -fsSL "$GITHUB_RAW/skills/draft-connect/slack/SKILL.md"    -o "$SHARED/skills/draft-connect/slack/SKILL.md"
fi
echo "[Draft]   skills → $SHARED/skills/"

# ── Agents (markdown — Claude Code / Cursor format) ────────────────────────────

if [ "$USE_LOCAL" = true ]; then
    cp "$PLUGIN_ROOT/agents/"*.md "$SHARED/agents/md/"
else
    for agent in draft-agent draft-executor draft-learner draft-researcher; do
        curl -fsSL "$GITHUB_RAW/agents/$agent.md" -o "$SHARED/agents/md/$agent.md"
    done
fi
echo "[Draft]   agents/md → $SHARED/agents/md/"

# ── Agents (TOML — Codex format) ───────────────────────────────────────────────
# Copied but not symlinked at the destination — TOML files have different
# content/schema and cannot share a source with the markdown agents.

if [ "$USE_LOCAL" = true ]; then
    cp "$PLUGIN_ROOT/.codex/agents/"*.toml "$SHARED/agents/toml/"
else
    for agent in draft-executor draft-learner draft-researcher; do
        curl -fsSL "$GITHUB_RAW/.codex/agents/$agent.toml" -o "$SHARED/agents/toml/$agent.toml"
    done
fi
echo "[Draft]   agents/toml → $SHARED/agents/toml/"

# ── Hook scripts ───────────────────────────────────────────────────────────────

fetch_file "scripts/inject-context.sh"       "$SHARED/hooks/inject-context.sh"
fetch_file "scripts/codex-session-end.sh"    "$SHARED/hooks/codex-session-end.sh"
fetch_file "scripts/cursor-session-start.sh" "$SHARED/hooks/cursor-session-start.sh"
chmod +x "$SHARED/hooks/"*.sh
echo "[Draft]   hooks → $SHARED/hooks/"

# ── Static content files ───────────────────────────────────────────────────────

fetch_file ".codex/AGENTS.md"              "$SHARED/codex-agents.md"
fetch_file ".cursor/rules/draft-context.mdc" "$SHARED/cursor-context.mdc"
echo "[Draft]   static files → $SHARED/"

echo "[Draft] ~/.draft/shared/ populated."
