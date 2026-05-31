#!/bin/bash
# SessionStart hook — injects Draft workspace context into every session.
#
# Runs the same commands as the workspace CLAUDE.md directly,
# so ! bash commands are always executed (not just printed as raw text).
#
# stdout: formatted context injected into Claude's system prompt
# stderr: profile banner, migration notices
#
# Profile resolution:
#   Always reads ~/.draft/active-profile to determine which workspace to load.
#   Any externally-set $DRAFT_WORKSPACE is intentionally unset so the profile
#   system is always authoritative. session-init.sh keeps settings.json in sync
#   so bash tool calls use the correct path after one restart.
#
# Personal layer: always at ~/.draft/personal/ (global — shared across all profiles)

DRAFT_GLOBAL="$HOME/.draft"

# Unset any externally-set DRAFT_WORKSPACE so profile resolution is always
# driven by active-profile — never overridden by a stale settings.json value.
unset DRAFT_WORKSPACE

# ── Migration: workspace/ → workspaces/default/ ────────────────────────────────
# Runs once for existing users upgrading to multi-profile support.
# Idempotent — safe to re-run (checks for workspaces/ before acting).
# Guard: if workspace/ is a symlink (power-user trick), skip migration entirely.
if [ -z "${DRAFT_WORKSPACE:-}" ] && [ -d "$DRAFT_GLOBAL/workspace" ] && [ ! -d "$DRAFT_GLOBAL/workspaces" ]; then
    if [ -L "$DRAFT_GLOBAL/workspace" ]; then
        echo "[Draft] workspace is a symlink — manual migration may be needed. See docs." >&2
    else
        # Step 1: Move workspace → workspaces/default
        mkdir -p "$DRAFT_GLOBAL/workspaces"
        mv "$DRAFT_GLOBAL/workspace" "$DRAFT_GLOBAL/workspaces/default"
        echo "default" > "$DRAFT_GLOBAL/active-profile"

        # Step 2: Elevate personal/ to global layer (~/.draft/personal/)
        _src="$DRAFT_GLOBAL/workspaces/default/personal"
        _dst="$DRAFT_GLOBAL/personal"

        if [ -d "$_src" ]; then
            if [ ! -d "$_dst" ]; then
                mv "$_src" "$_dst"
            else
                # Destination exists — merge: copy files that don't exist at destination
                find "$_src" -type f | while IFS= read -r _f; do
                    _rel="${_f#$_src/}"
                    _dest_f="$_dst/$_rel"
                    if [ ! -f "$_dest_f" ]; then
                        mkdir -p "$(dirname "$_dest_f")"
                        mv "$_f" "$_dest_f"
                        echo "[Draft] Merged: personal/$_rel" >&2
                    else
                        echo "[Draft] Skipped (exists): personal/$_rel" >&2
                    fi
                done
                rm -rf "$_src"
            fi
        fi

        echo "[Draft] Migrated to multi-profile. Active profile: default. Run /draft:profiles to manage profiles." >&2
    fi
fi

# ── Profile resolution ─────────────────────────────────────────────────────────
# Always compute DRAFT_WORKSPACE from active-profile. Never rely on an externally-
# set value — session-init.sh keeps settings.json current for bash tool calls.

_active_profile_file="$DRAFT_GLOBAL/active-profile"
_active_profile=""

if [ -f "$_active_profile_file" ]; then
    _active_profile=$(tr -d '[:space:]' < "$_active_profile_file")
fi

if [ -z "$_active_profile" ]; then
    # No active-profile set
    if [ -d "$DRAFT_GLOBAL/workspaces/default" ]; then
        _active_profile="default"
    else
        # Net-new install — silent default (setup will create the directory)
        _active_profile="default"
    fi
fi

DRAFT_WORKSPACE="$DRAFT_GLOBAL/workspaces/$_active_profile"

if [ ! -d "$DRAFT_WORKSPACE" ] && [ -d "$DRAFT_GLOBAL/workspaces" ]; then
    echo "[Draft] Profile '$_active_profile' not found. Run /draft:profiles to see available profiles." >&2
    exit 0
fi

echo "[Draft] Active profile: $_active_profile" >&2

export DRAFT_WORKSPACE
DRAFT_PERSONAL="$DRAFT_GLOBAL/personal"

# ── Skip gracefully if workspace not yet initialized ───────────────────────────
if [ ! -d "$DRAFT_WORKSPACE/context" ]; then
    echo "(Draft workspace not initialized — run /draft:setup)"
    exit 0
fi

echo "# Draft — Workspace Context"
echo ""
echo "**Active profile:** $_active_profile"
echo "**DRAFT_WORKSPACE:** $DRAFT_WORKSPACE"
echo ""
echo "## Workspace structure"
tree -L 2 --charset ascii "$DRAFT_WORKSPACE/context/" 2>/dev/null || echo "(context/ not found — run /draft:setup)"
echo ""
echo "## Context index"
python3 -c "
import os
from pathlib import Path
ws = os.environ.get('DRAFT_WORKSPACE', os.path.expanduser('~/.draft/workspaces/default'))
ctx = Path(ws) / 'context'
files = sorted(ctx.glob('*/index.md'))
if not files:
    print('No context loaded yet — run /draft:setup to initialize your shared context layer.')
else:
    for idx in files:
        try:
            text = idx.read_text()
            parts = text.split('---')
            fm = parts[1].strip() if len(parts) >= 3 else text[:300]
            print(f'**{idx.parent.name}**')
            print(fm)
            print()
        except Exception:
            pass
" 2>/dev/null || echo "Run /draft:setup to initialize your shared context layer."
echo ""
echo "## Current priorities"
cat "$DRAFT_WORKSPACE/context/priorities/index.md" 2>/dev/null || echo "No priorities recorded yet."

# ── Memory (personal layer — global, shared across all profiles) ───────────────
if [ -f "$DRAFT_PERSONAL/memory.md" ]; then
    echo ""
    echo "## Memory"
    cat "$DRAFT_PERSONAL/memory.md" 2>/dev/null
fi

# ── Collaboration status (per-profile — reads from active workspace config/) ───
if [ -f "$DRAFT_WORKSPACE/config/collaboration.json" ]; then
    echo ""
    echo "## Collaboration"
    python3 -c "
import os, json
from pathlib import Path
ws = Path(os.environ.get('DRAFT_WORKSPACE', os.path.expanduser('~/.draft/workspaces/default')))
collab = ws / 'config' / 'collaboration.json'
local = ws / 'config' / 'local.json'

c = json.loads(collab.read_text()) if collab.exists() else {}
l = json.loads(local.read_text()) if local.exists() else {}

if c.get('mode') == 'github':
    teammates = c.get('teammates', [])
    teammates_str = ', '.join(teammates) if teammates else '—'
    print(f\"mode: {c.get('mode', '—')}\")
    print(f\"repo: {c.get('team_repo_url', '—')} / {c.get('team_repo_subdir', 'root')}\")
    print(f\"teammates: {teammates_str}\")
    print(f\"last_published: {l.get('last_published', None) or 'never'}\")
    print(f\"last_loaded: {l.get('last_loaded', None) or 'never'}\")
" 2>/dev/null
fi

# ── Update notification ────────────────────────────────────────────────────────
# Read cached check result from config.json, fall back to flat file.
# If an upgrade is available, inject a notice so pm-agent surfaces it to the user.

UPDATE_STATUS=""
OLD_VER=""
NEW_VER=""

# Try config.json first (canonical source)
_CONFIG="$HOME/.draft/config.json"
if [ -f "$_CONFIG" ]; then
    _RESULT=$(python3 -c "
import json, pathlib
cfg = json.loads(pathlib.Path('$_CONFIG').read_text())
luc = cfg.get('last_update_check', {})
print(luc.get('status', ''))
print(luc.get('installed_version', ''))
print(luc.get('latest_version', ''))
" 2>/dev/null || echo "")
    UPDATE_STATUS=$(echo "$_RESULT" | sed -n '1p')
    OLD_VER=$(echo "$_RESULT" | sed -n '2p')
    NEW_VER=$(echo "$_RESULT" | sed -n '3p')
fi

# Fall back to flat file if config.json had nothing
if [ -z "$UPDATE_STATUS" ]; then
    LAST_CHECK="$HOME/.draft/last-update-check"
    if [ -f "$LAST_CHECK" ]; then
        read -r UPDATE_STATUS OLD_VER NEW_VER _EXTRA < "$LAST_CHECK" 2>/dev/null || true
    fi
fi

if [ "${UPDATE_STATUS:-}" = "UPGRADE_AVAILABLE" ]; then
    echo ""
    echo "## Draft Update Available"
    echo "v${NEW_VER} is available (currently on v${OLD_VER}). Mention this to the user and offer to run \`/draft:update\` to upgrade."
fi

# ── Load-team notifications ────────────────────────────────────────────────────
# load-team.sh writes one of two files depending on what happened at session start.
# Both are cleared after reading — written fresh each session as needed.

# Success: new team context was pulled from the shared repo.
_LOAD_OK="$DRAFT_WORKSPACE/notifications/load-team-loaded.txt"
if [ -f "$_LOAD_OK" ]; then
    echo ""
    echo "## Team Context Refreshed"
    cat "$_LOAD_OK"
    echo "Please mention to the user at the start of this conversation that their team context was just refreshed from the shared repo."
    rm -f "$_LOAD_OK"
fi

# Warning: unpublished local changes detected — overwrite was skipped.
_LOAD_WARN="$DRAFT_WORKSPACE/notifications/load-team-warning.txt"
if [ -f "$_LOAD_WARN" ]; then
    echo ""
    echo "## ⚠️ Draft Warning — Unpublished Local Changes"
    echo ""
    cat "$_LOAD_WARN"
    echo "Please alert the user to this at the start of this conversation."
    rm -f "$_LOAD_WARN"
fi

# Fire background update check — never blocks session start.
# Writes fresh result to ~/.draft/last-update-check for the next session.
if [ -f "$HOME/.draft/scripts/draft-update-check.sh" ]; then
    bash "$HOME/.draft/scripts/draft-update-check.sh" >/dev/null 2>&1 &
fi
