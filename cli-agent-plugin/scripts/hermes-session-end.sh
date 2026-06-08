#!/bin/bash
# Draft — Hermes session-end hook
#
# Called by the Hermes plugin at session end:
#   bash hermes-session-end.sh <session_id>
#
# transcript_path is derived from session_id: ~/.hermes/sessions/session_<id>.json
#
# Writes/updates a pending synthesis record for this session.
# The daemon reads pending files and synthesizes on its 60-min polling cycle.

set -euo pipefail

DRAFT_GLOBAL="${HOME}/.draft"
PENDING_DIR="${DRAFT_GLOBAL}/pending"

mkdir -p "$PENDING_DIR"

session_id="${1:-}"
transcript_path="${DRAFT_GLOBAL}/sessions/session_${session_id}.json"

if [ -z "$session_id" ]; then
    exit 0
fi

pending_file="$PENDING_DIR/hermes-${session_id}.json"
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
    "transcript_path": "$transcript_path",
    "updated_at": $now,
    "last_synthesized_at": $last_synthesized_at
}

Path("$pending_file").write_text(json.dumps(data, indent=2) + "\n")
PYEOF

exit 0
