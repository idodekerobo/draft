#!/bin/bash
# SessionStart hook — runs on every session start.
#
# - Bootstraps the active profile workspace from template (first run per profile)
# - Writes DRAFT_WORKSPACE + additionalDirectories + permissions to settings.json
#   every session so profile switches take effect on the next restart.
#
# Context injection is handled separately by inject-context.sh.
#
# stdout: empty (inject-context.sh handles context injection)
# stderr: status messages (not shown to Claude)

set -euo pipefail

DRAFT_GLOBAL="$HOME/.draft"
TEMPLATE="${CLAUDE_PLUGIN_ROOT}/workspace-template"
SETTINGS="$HOME/.claude/settings.json"

# ── Determine active profile ──────────────────────────────────────────────────
# Read active-profile to compute WORKSPACE dynamically each session.
# Falls back to "default" if no profile is set yet.
# This runs every session so that /draft:switch takes effect on the next restart.

_profile_file="$DRAFT_GLOBAL/active-profile"
_active_profile="default"

if [ -f "$_profile_file" ]; then
    _read_profile=$(tr -d '[:space:]' < "$_profile_file")
    if [ -n "$_read_profile" ]; then
        _active_profile="$_read_profile"
    fi
fi

WORKSPACE="$DRAFT_GLOBAL/workspaces/$_active_profile"

# ── 1. Bootstrap workspace ────────────────────────────────────────────────────
# Creates the profile workspace directory from template if it doesn't exist yet.
# Legacy ~/.draft/workspace/ migration is handled by inject-context.sh.

if [ ! -d "$WORKSPACE" ]; then
    echo "[Draft] Initializing workspace for profile '$_active_profile' at $WORKSPACE..." >&2
    mkdir -p "$WORKSPACE"
    cp -r "$TEMPLATE/." "$WORKSPACE/"
    # Write active-profile if this is a net-new install
    if [ ! -f "$_profile_file" ]; then
        echo "$_active_profile" > "$_profile_file"
    fi
    echo "[Draft] Workspace ready. Run /draft:setup to load your PM brain." >&2
fi

# ── 1b. Record installed version ──────────────────────────────────────────────
# Runs every session so the recorded version always matches the installed plugin.

PLUGIN_VERSION=$(cat "${CLAUDE_PLUGIN_ROOT}/VERSION" 2>/dev/null || echo "unknown")
mkdir -p "$DRAFT_GLOBAL"
echo "$PLUGIN_VERSION" > "$DRAFT_GLOBAL/version"

# ── 1c. Install shared scripts ─────────────────────────────────────────────────
# Copies update scripts to ~/.draft/scripts/ so they're accessible from all platforms.
# Runs every session so Codex/Cursor users always get the latest version.

if [ -f "${CLAUDE_PLUGIN_ROOT}/scripts/draft-update-check.sh" ]; then
    mkdir -p "$DRAFT_GLOBAL/scripts"
    cp "${CLAUDE_PLUGIN_ROOT}/scripts/draft-update-check.sh" "$DRAFT_GLOBAL/scripts/draft-update-check.sh"
    cp "${CLAUDE_PLUGIN_ROOT}/scripts/draft-update.sh" "$DRAFT_GLOBAL/scripts/draft-update.sh"
    chmod +x "$DRAFT_GLOBAL/scripts/draft-update-check.sh" "$DRAFT_GLOBAL/scripts/draft-update.sh"
fi

# ── 2. Configure ~/.claude/settings.json ─────────────────────────────────────
# Updates DRAFT_WORKSPACE every session to match the active profile.
# This ensures bash tool calls use the correct workspace path one restart after
# a profile switch (settings.json is read by Claude Code at startup, before hooks run).
#
# Permissions are set broadly (all of ~/.draft/**) so they cover any profile
# without needing per-profile permission updates.

python3 - <<PYEOF
import json, sys
from pathlib import Path

settings_path = Path("$SETTINGS")
workspace = "$WORKSPACE"
draft_global = "$DRAFT_GLOBAL"

if settings_path.exists():
    try:
        settings = json.loads(settings_path.read_text())
    except Exception:
        settings = {}
else:
    settings = {}

changed = False

# Update DRAFT_WORKSPACE to active profile's workspace — runs every session
env = settings.setdefault("env", {})
if env.get("DRAFT_WORKSPACE") != workspace:
    env["DRAFT_WORKSPACE"] = workspace
    changed = True

# Set additionalDirectories to cover ~/.draft/workspaces/ (all profiles)
perms = settings.setdefault("permissions", {})
dirs = perms.setdefault("additionalDirectories", [])
workspaces_dir = str(Path(draft_global) / "workspaces")
if workspaces_dir not in dirs:
    dirs.append(workspaces_dir)
    changed = True

# Grant ~/.draft/** permissions so Claude can read/write any profile's files
draft_glob = draft_global + "/**"
allow = perms.setdefault("allow", [])
for perm in [f"Write({draft_glob})", f"Read({draft_glob})", f"Edit({draft_glob})"]:
    if perm not in allow:
        allow.append(perm)
        changed = True

if changed:
    settings_path.parent.mkdir(parents=True, exist_ok=True)
    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    print("[Draft] Settings updated.", file=sys.stderr)
PYEOF
