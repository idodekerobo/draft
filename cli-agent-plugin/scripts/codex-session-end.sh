#!/bin/bash
# Draft — Codex session-end hook
#
# Fired by Codex Stop event after each turn ends.
# Writes/updates a pending synthesis record for this session.
# The daemon reads pending files and synthesizes on its 60-min polling cycle.
#
# Input (stdin): JSON with session_id, transcript_path, turn_id, etc.
# Output: exit 0 (continue) — no stdout needed

set -euo pipefail

DRAFT_GLOBAL="${HOME}/.draft"
PENDING_DIR="${DRAFT_GLOBAL}/pending"

mkdir -p "$PENDING_DIR"

# Read stdin once
input=$(cat)

session_id=$(echo "$input" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || echo "")
transcript_path=$(echo "$input" | python3 -c "import json,sys; d=json.load(sys.stdin); v=d.get('transcript_path'); print(v if v else '')" 2>/dev/null || echo "")

# Fallback: if Codex sent null/empty, search ~/.codex/sessions/ by session_id
# Confirmed pattern: rollout-{timestamp}-{session_id}.jsonl
if [ -z "$transcript_path" ] && [ -n "$session_id" ]; then
    transcript_path=$(find "$HOME/.codex/sessions" -name "*${session_id}*.jsonl" 2>/dev/null | head -1)
fi

# Nothing to do without a session_id
if [ -z "$session_id" ]; then
    exit 0
fi

pending_file="$PENDING_DIR/codex-${session_id}.json"
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

last_val = "$last_synthesized_at"
data = {
    "session_id": "$session_id",
    "transcript_path": "$transcript_path",
    "updated_at": $now,
    "last_synthesized_at": None if last_val == "null" else int(last_val)
}

Path("$pending_file").write_text(json.dumps(data, indent=2) + "\n")
PYEOF

exit 0
