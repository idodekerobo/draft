#!/bin/bash
# on-session-end.sh — Draft SessionEnd hook
#
# Fires when a Claude Code session ends (registered in hooks.json as SessionEnd hook).
# Writes a JSON job file to ~/.draft/background/pending/ atomically, then exits 0.
#
# CRITICAL: Read stdin FIRST — it is a pipe and will be lost if not consumed immediately.
#
# Claude Code passes a JSON payload via stdin at SessionEnd:
#   {
#     "session_id":      "<uuid>",
#     "transcript_path": "/path/to/.claude/projects/<slug>/<uuid>.jsonl",
#     "cwd":             "/path/to/project",
#     "agent_type":      "draft:draft-agent",
#     "hook_event_name": "SessionEnd",
#     "reason":          "prompt_input_exit"
#   }
#
# This script never waits for synthesis. Synthesis is handled async by draft-background.ts.
# If the daemon is not installed (pending/ doesn't exist), this is a no-op.

# ── Read stdin immediately ─────────────────────────────────────────────────────
HOOK_INPUT=$(cat)

DRAFT_GLOBAL="$HOME/.draft"
DRAFT_BACKGROUND="$DRAFT_GLOBAL/background"
DRAFT_PENDING="$DRAFT_BACKGROUND/pending"

# No-op if daemon is not installed
if [ ! -d "$DRAFT_PENDING" ]; then
    exit 0
fi

# ── Parse stdin payload ────────────────────────────────────────────────────────
SESSION_ID=$(printf '%s' "$HOOK_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id','unknown'))" 2>/dev/null || echo "unknown")
TRANSCRIPT_PATH=$(printf '%s' "$HOOK_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || echo "")
CWD=$(printf '%s' "$HOOK_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null || echo "")
REASON=$(printf '%s' "$HOOK_INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('reason','unknown'))" 2>/dev/null || echo "unknown")

# ── Active profile ─────────────────────────────────────────────────────────────
DRAFT_ACTIVE_PROFILE="default"
_profile_file="$DRAFT_GLOBAL/active-profile"
if [ -f "$_profile_file" ]; then
    _p=$(tr -d '[:space:]' < "$_profile_file")
    [ -n "$_p" ] && DRAFT_ACTIVE_PROFILE="$_p"
fi

# ── Build job payload ──────────────────────────────────────────────────────────
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

JOB_JSON="{\"profile\":\"${DRAFT_ACTIVE_PROFILE}\",\"session_id\":\"${SESSION_ID}\",\"transcript_path\":\"${TRANSCRIPT_PATH}\",\"cwd\":\"${CWD}\",\"reason\":\"${REASON}\",\"timestamp\":\"${TIMESTAMP}\"}"

# ── Atomic write ───────────────────────────────────────────────────────────────
# uuidgen for unique filename — safe for simultaneous session closes.
# Write to .tmp first, then rename — daemon never reads a partial file.
JOB_ID=$(uuidgen 2>/dev/null || printf '%04x%04x%04x%04x' $RANDOM $RANDOM $RANDOM $RANDOM)
JOB_FILE="$DRAFT_PENDING/job-${JOB_ID}.json"
TMPFILE=$(mktemp "$DRAFT_PENDING/.tmp.XXXXXX")
printf '%s\n' "$JOB_JSON" > "$TMPFILE"
mv "$TMPFILE" "$JOB_FILE"

exit 0
