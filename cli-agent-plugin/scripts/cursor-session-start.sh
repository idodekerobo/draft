#!/bin/bash
# Draft — Cursor sessionStart hook
#
# Injects Draft workspace context into every Cursor session as additional_context.
# Cursor treats this as initial system context for the conversation.
#
# Output protocol:
#   stdout: JSON { "additional_context": "<workspace context>" }
#   stderr: silent (Cursor does not surface hook stderr to the user)
#   exit 0: always (sessionStart is fire-and-forget)
#
# Banner channel: Cursor stderr is silent. The profile banner goes into the
#   additional_context JSON payload as a prefix line — NOT to stderr.
#
# Profile resolution:
#   0. If $DRAFT_WORKSPACE is set externally, use it (banner shows path, not name)
#   1. Read ~/.draft/active-profile → get profile name
#   2. Set DRAFT_WORKSPACE=~/.draft/workspaces/<profile-name>
#
# Personal layer: always at ~/.draft/personal/ (global — shared across all profiles)
#
# Installed by cursor-setup.sh to ~/.cursor/hooks/draft/cursor-session-start.sh

DRAFT_GLOBAL="$HOME/.draft"

# ── Migration: workspace/ → workspaces/default/ ────────────────────────────────
# Same logic as inject-context.sh. Runs silently — Cursor stderr is not visible.
if [ -z "${DRAFT_WORKSPACE:-}" ] && [ -d "$DRAFT_GLOBAL/workspace" ] && [ ! -d "$DRAFT_GLOBAL/workspaces" ]; then
    if [ ! -L "$DRAFT_GLOBAL/workspace" ]; then
        mkdir -p "$DRAFT_GLOBAL/workspaces"
        mv "$DRAFT_GLOBAL/workspace" "$DRAFT_GLOBAL/workspaces/default"
        echo "default" > "$DRAFT_GLOBAL/active-profile"

        _src="$DRAFT_GLOBAL/workspaces/default/personal"
        _dst="$DRAFT_GLOBAL/personal"

        if [ -d "$_src" ]; then
            if [ ! -d "$_dst" ]; then
                mv "$_src" "$_dst"
            else
                find "$_src" -type f | while IFS= read -r _f; do
                    _rel="${_f#$_src/}"
                    _dest_f="$_dst/$_rel"
                    if [ ! -f "$_dest_f" ]; then
                        mkdir -p "$(dirname "$_dest_f")"
                        mv "$_f" "$_dest_f"
                    fi
                done
                rm -rf "$_src"
            fi
        fi
    fi
fi

# ── Profile resolution ─────────────────────────────────────────────────────────
_draft_profile_name=""

if [ -n "${DRAFT_WORKSPACE:-}" ]; then
    # Externally set — use it as-is; banner will show path
    _draft_profile_name=""
else
    _active_profile_file="$DRAFT_GLOBAL/active-profile"
    _active_profile=""

    if [ -f "$_active_profile_file" ]; then
        _active_profile=$(tr -d '[:space:]' < "$_active_profile_file")
    fi

    if [ -z "$_active_profile" ]; then
        _active_profile="default"
    fi

    DRAFT_WORKSPACE="$DRAFT_GLOBAL/workspaces/$_active_profile"
    _draft_profile_name="$_active_profile"
fi

export DRAFT_WORKSPACE
export DRAFT_GLOBAL
export DRAFT_PROFILE_NAME="$_draft_profile_name"

# ── Guard: workspace not initialized ──────────────────────────────────────────
if [ ! -d "$DRAFT_WORKSPACE/context" ]; then
    python3 -c "
import json
print(json.dumps({
    'additional_context': 'Draft workspace not initialized. Run /draft:setup to load your PM brain.'
}))
"
    exit 0
fi

# ── Build and emit context as JSON ────────────────────────────────────────────
#
# Python handles JSON encoding to avoid shell quoting hazards.
# Context files contain arbitrary markdown (quotes, newlines, special chars).
# Banner goes into additional_context as a prefix line (stderr is silent in Cursor).

python3 - <<'PYEOF'
import os, json, subprocess
from pathlib import Path

ws = os.environ.get("DRAFT_WORKSPACE", os.path.expanduser("~/.draft/workspaces/default"))
draft_global = os.environ.get("DRAFT_GLOBAL", os.path.expanduser("~/.draft"))
profile_name = os.environ.get("DRAFT_PROFILE_NAME", "")

ctx_dir = Path(ws) / "context"
# Personal layer is global — shared across all profiles
mem_file = Path(draft_global) / "personal" / "memory.md"

parts = []

# ── Profile banner (Cursor: banner in additional_context, not stderr) ──────────
# Cursor's stderr is silent — the user must see which profile is active here.
if profile_name:
    parts.append(f"Draft workspace: {profile_name}\n")
else:
    # DRAFT_WORKSPACE was set externally — show the resolved path
    parts.append(f"Draft workspace: {ws}\n")

parts += ["# Draft — Workspace Context", ""]

# ── Workspace directory tree (2 levels) ───────────────────────────────────────
parts.append("## Workspace structure")
try:
    result = subprocess.run(
        ["tree", "-L", "2", "--charset", "ascii", str(ctx_dir)],
        capture_output=True, text=True, timeout=5
    )
    parts.append(result.stdout.strip() if result.returncode == 0 else "(tree not available)")
except Exception:
    # tree not installed; fall back to a simple listing
    try:
        dirs = sorted([p.name for p in ctx_dir.iterdir() if p.is_dir()])
        parts.append("context/")
        for d in dirs:
            parts.append(f"  {d}/")
    except Exception:
        parts.append("(context/ not found — run /draft:setup)")
parts.append("")

# ── Context index: frontmatter description from each dimension ─────────────────
parts.append("## Context index")
index_files = sorted(ctx_dir.glob("*/index.md"))
if index_files:
    for idx in index_files:
        try:
            text = idx.read_text()
            sections = text.split("---")
            # YAML frontmatter lives between the first and second ---
            fm = sections[1].strip() if len(sections) >= 3 else text[:300]
            parts.append(f"**{idx.parent.name}**")
            parts.append(fm)
            parts.append("")
        except Exception:
            pass
else:
    parts.append("No context loaded yet — run /draft:setup to initialize your PM brain.")
    parts.append("")

# ── Current priorities (full content) ─────────────────────────────────────────
parts.append("## Current priorities")
priorities = ctx_dir / "priorities" / "index.md"
if priorities.exists():
    parts.append(priorities.read_text().strip())
else:
    parts.append("No priorities recorded yet.")
parts.append("")

# ── Memory (global personal layer — shared across all profiles) ────────────────
parts.append("## Memory")
if mem_file.exists():
    parts.append(mem_file.read_text().strip())
else:
    parts.append("No memory yet.")

# ── Collaboration status (per-profile — reads from active workspace config/) ───
_collab = Path(ws) / "config" / "collaboration.json"
_local_cfg = Path(ws) / "config" / "local.json"
if _collab.exists():
    try:
        import json as _json
        _c = _json.loads(_collab.read_text())
        _l = _json.loads(_local_cfg.read_text()) if _local_cfg.exists() else {}
        if _c.get("mode") == "github":
            _teammates = _c.get("teammates", [])
            _teammates_str = ", ".join(_teammates) if _teammates else "—"
            parts.append("")
            parts.append("## Collaboration")
            parts.append(f"mode: {_c.get('mode', '—')}")
            parts.append(f"repo: {_c.get('team_repo_url', '—')} / {_c.get('team_repo_subdir', 'root')}")
            parts.append(f"teammates: {_teammates_str}")
            parts.append(f"last_published: {_l.get('last_published', None) or 'never'}")
            parts.append(f"last_loaded: {_l.get('last_loaded', None) or 'never'}")
    except Exception:
        pass

# ── Update notification ────────────────────────────────────────────────────────
import pathlib as _pl
_last_check = _pl.Path.home() / ".draft" / "last-update-check"
if _last_check.exists():
    try:
        _check = _last_check.read_text().strip().split()
        if len(_check) >= 3 and _check[0] == "UPGRADE_AVAILABLE":
            _old_ver, _new_ver = _check[1], _check[2]
            parts.append("")
            parts.append("## Draft Update Available")
            parts.append(f"v{_new_ver} is available (currently on v{_old_ver}). Mention this to the user and offer to run `/draft:update` to upgrade.")
    except Exception:
        pass

print(json.dumps({"additional_context": "\n".join(parts)}))
PYEOF

# Fire background update check — never blocks session start.
# Writes fresh result to ~/.draft/last-update-check for the next session.
if [ -f "$HOME/.draft/scripts/draft-update-check.sh" ]; then
    bash "$HOME/.draft/scripts/draft-update-check.sh" >/dev/null 2>&1 &
fi
