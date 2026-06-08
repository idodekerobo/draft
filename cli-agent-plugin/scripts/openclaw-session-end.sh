#!/bin/bash
# Draft — OpenClaw session-end hook
#
# Called by the OpenClaw plugin at session end:
#   bash openclaw-session-end.sh <session_id> <session_file> <reason>
#
# Writes/updates a pending synthesis record for this session.
# The daemon reads pending files and synthesizes on its 60-min polling cycle.

set -euo pipefail

DRAFT_GLOBAL="${HOME}/.draft"
PENDING_DIR="${DRAFT_GLOBAL}/pending"

mkdir -p "$PENDING_DIR"

session_id="${1:-}"
session_file="${2:-}"
openclaw_reason="${3:-unknown}"

if [ -z "$session_id" ]; then
    exit 0
fi

# ── Active profile ──────────────────────────────────────────────────────────
profile="default"
_profile_file="$DRAFT_GLOBAL/active-profile"
if [ -f "$_profile_file" ]; then
    _p=$(tr -d '[:space:]' < "$_profile_file")
    [ -n "$_p" ] && profile="$_p"
fi

# ── Map OpenClaw reason to synthesis reason ─────────────────────────────────
# synthesize.sh skips jobs where reason != "prompt_input_exit".
# idle    = session naturally wound down (user finished)
# daily   = daily reset cycle (real work happened)
# shutdown = gateway clean shutdown (completed session)
case "$openclaw_reason" in
    idle|daily|shutdown)
        synthesis_reason="prompt_input_exit"
        ;;
    *)
        synthesis_reason="$openclaw_reason"
        ;;
esac

pending_file="$PENDING_DIR/openclaw-${session_id}.json"
now=$(date +%s)

# Preserve last_synthesized_at if a pending record already exists for this session
last_synthesized_at="null"
if [ -f "$pending_file" ]; then
    last_synthesized_at=$(python3 - <<PYEOF 2>/dev/null || echo "null"
import json
try:
    d = json.load(open("$pending_file"))
    v = d.get("last_synthesized_at")
    print("null" if v is None else str(int(v)))
except Exception:
    print("null")
PYEOF
)
fi

# Write updated pending record
python3 - <<PYEOF
import json
from pathlib import Path

data = {
    "session_id": "$session_id",
    "transcript_path": "$session_file",
    "profile": "$profile",
    "reason": "$synthesis_reason",
    "updated_at": $now,
    "last_synthesized_at": $last_synthesized_at
}

Path("$pending_file").write_text(json.dumps(data, indent=2) + "\n")
PYEOF

exit 0
