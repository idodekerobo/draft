#!/bin/bash
# commit-to-team-context.sh — Push daemon-synthesized context to shared repo
#
# Called by /publish-team skill after the curator approves proposals/ files.
# Applies context_updates from synthesis .md files, writes CHANGES.jsonl entries
# with daemon provenance, and pushes via the separate-clone pattern.
#
# The Draft workspace (~/.draft/workspaces/) is NEVER initialized as a git repo.
# All git operations happen in a short-lived temp directory (separate-clone pattern).
#
# Usage: bash commit-to-team-context.sh <staging_file> <workspace> <gh_username>
#   staging_file — .md file from proposals/ (YAML frontmatter + markdown body)
#   workspace    — path to Draft workspace (e.g. ~/.draft/workspaces/draft-pm-agent)
#   gh_username  — GitHub username of the curator (for CHANGES.jsonl)

set -uo pipefail

STAGING_FILE="$1"
WORKSPACE="$2"
GH_USERNAME="$3"

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=config.sh
source "$DRAFT_BACKGROUND/config.sh"

_log() {
    printf '[commit-to-team-context.sh] %s\n' "$*" >&2
}

_fail() {
    _log "ERROR: $*"
    exit 1
}

# ── Read collaboration config ──────────────────────────────────────────────────
COLLAB_CONFIG="$WORKSPACE/config/collaboration.json"
LOCAL_CONFIG="$WORKSPACE/config/local.json"

[ -f "$COLLAB_CONFIG" ] || _fail "collaboration.json not found at $COLLAB_CONFIG"
[ -f "$LOCAL_CONFIG"  ] || _fail "local.json not found at $LOCAL_CONFIG"

TEAM_REPO_URL=$(python3 -c "
import json
print(json.load(open('$COLLAB_CONFIG')).get('team_repo_url', ''))
" 2>/dev/null || echo "")

TEAM_REPO_SUBDIR=$(python3 -c "
import json
print(json.load(open('$COLLAB_CONFIG')).get('team_repo_subdir', 'root'))
" 2>/dev/null || echo "root")

[ -n "$TEAM_REPO_URL" ] || _fail "team_repo_url not set in collaboration.json"

# ── Parse staging file frontmatter ────────────────────────────────────────────
[ -f "$STAGING_FILE" ] || _fail "staging file not found: $STAGING_FILE"

SESSION_ID=$(python3 - <<PYEOF
import sys
content = open('$STAGING_FILE').read()
# Extract YAML frontmatter between --- markers
parts = content.split('---')
if len(parts) < 3:
    sys.exit(1)
fm = parts[1]
for line in fm.splitlines():
    if line.startswith('session_id:'):
        print(line.split(':', 1)[1].strip())
        sys.exit(0)
print('unknown')
PYEOF
)

SYNTHESIZED_BY=$(python3 - <<PYEOF
import sys
content = open('$STAGING_FILE').read()
parts = content.split('---')
if len(parts) < 3:
    print('claude-code')
    sys.exit(0)
fm = parts[1]
for line in fm.splitlines():
    if line.startswith('synthesized_by:'):
        print(line.split(':', 1)[1].strip())
        sys.exit(0)
print('claude-code')
PYEOF
)

INPUT_SOURCE=$(python3 - <<PYEOF
import sys
content = open('$STAGING_FILE').read()
parts = content.split('---')
if len(parts) < 3:
    print('session')
    sys.exit(0)
fm = parts[1]
for line in fm.splitlines():
    if line.startswith('input_source:'):
        print(line.split(':', 1)[1].strip())
        sys.exit(0)
print('session')
PYEOF
)

_log "applying staging file: $(basename "$STAGING_FILE")"
_log "  session_id=$SESSION_ID input_source=$INPUT_SOURCE synthesized_by=$SYNTHESIZED_BY"

# ── Apply context_updates to workspace ────────────────────────────────────────
# Parse context_updates from YAML frontmatter and apply to context/ files.
python3 - <<PYEOF
import sys, re, os

staging = open('$STAGING_FILE').read()
workspace = '$WORKSPACE'
input_source = '$INPUT_SOURCE'

# Extract YAML frontmatter
parts = staging.split('---')
if len(parts) < 3:
    sys.stderr.write('ERROR: no YAML frontmatter found\n')
    sys.exit(1)

frontmatter = parts[1]

# Parse context_updates manually (avoid PyYAML dep)
updates = []
current = {}
in_content = False
content_lines = []
content_indent = 0

for line in frontmatter.splitlines():
    # Detect start of a new update item
    if re.match(r'\s{2}-\s+file:', line):
        if current and content_lines is not None:
            current['content'] = '\n'.join(content_lines).rstrip('\n')
            updates.append(current)
        current = {'file': line.split('file:', 1)[1].strip()}
        in_content = False
        content_lines = []
    elif current and re.match(r'\s{4}action:', line):
        current['action'] = line.split('action:', 1)[1].strip()
    elif current and re.match(r'\s{4}content:\s*\|', line):
        in_content = True
        content_lines = []
        # Detect content block indent (lines below use 6-space indent)
        content_indent = 6
    elif in_content:
        # Content block ends when indent drops below content_indent
        stripped = line.rstrip()
        if stripped and not line.startswith(' ' * content_indent):
            in_content = False
        else:
            content_lines.append(line[content_indent:] if len(line) >= content_indent else '')

if current:
    if content_lines:
        current['content'] = '\n'.join(content_lines).rstrip('\n')
    updates.append(current)

if not updates:
    sys.stderr.write('INFO: no context_updates found in frontmatter\n')
    sys.exit(0)

# Apply each update
for u in updates:
    target_file = os.path.join(workspace, u.get('file', ''))
    action = u.get('action', 'append')
    content = u.get('content', '')

    if not content:
        sys.stderr.write(f"WARN: skipping empty content for {target_file}\n")
        continue

    os.makedirs(os.path.dirname(target_file), exist_ok=True)

    if action == 'tension':
        # Tension entries always route to context/tensions.md regardless of the file field.
        # The file field is metadata describing which dimension the contradiction relates to.
        tensions_file = os.path.join(workspace, 'context', 'tensions.md')
        os.makedirs(os.path.dirname(tensions_file), exist_ok=True)
        with open(tensions_file, 'a') as f:
            f.write('\n' + content + '\n')
        sys.stderr.write(f"applied tension → context/tensions.md (contradicts {u['file']})\n")
    elif action == 'overwrite':
        # Guard: overwrite is reserved for /draft:compact only — reject from all synthesizers.
        # Synthesis sources (session, granola, slack) must use 'append' or 'tension' only.
        allowed_overwrite_sources = ['compact']
        if input_source not in allowed_overwrite_sources:
            sys.stderr.write(
                f"ERROR: action: overwrite rejected — source '{input_source}' is not permitted to overwrite.\n"
                f"  Synthesizers must use 'append' or 'tension'. 'overwrite' is reserved for /draft:compact only.\n"
            )
            sys.exit(1)
        with open(target_file, 'w') as f:
            f.write(content + '\n')
        sys.stderr.write(f"applied overwrite: {u['file']}\n")
    else:  # append (default)
        with open(target_file, 'a') as f:
            f.write('\n' + content + '\n')
        sys.stderr.write(f"applied append: {u['file']}\n")

sys.exit(0)
PYEOF

APPLY_EXIT=$?
[ $APPLY_EXIT -eq 0 ] || _fail "failed to apply context_updates from staging file"

# ── Separate-clone pattern ─────────────────────────────────────────────────────
TMPDIR=$(mktemp -d /tmp/draft-commit-XXXXXX)
_cleanup_tmp() { rm -rf "$TMPDIR"; }
trap _cleanup_tmp EXIT

_log "cloning $TEAM_REPO_URL..."
git clone "$TEAM_REPO_URL" "$TMPDIR" --quiet 2>&1 | while IFS= read -r line; do _log "  git: $line"; done

# Resolve subdir
if [ "$TEAM_REPO_SUBDIR" = "root" ]; then
    SUBDIR_PATH="$TMPDIR"
else
    SUBDIR_PATH="$TMPDIR/$TEAM_REPO_SUBDIR"
fi
mkdir -p "$SUBDIR_PATH/context" "$SUBDIR_PATH/config"

# Copy updated context to clone
cp -r "$WORKSPACE/context/" "$SUBDIR_PATH/context/"
cp "$WORKSPACE/config/collaboration.json" "$SUBDIR_PATH/config/collaboration.json" 2>/dev/null || true

# ── Write CHANGES.jsonl entry ──────────────────────────────────────────────────
CHANGES_FILE="$SUBDIR_PATH/CHANGES.jsonl"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Collect updated files
UPDATED_FILES=$(python3 - <<PYEOF
import json, sys
staging = open('$STAGING_FILE').read()
parts = staging.split('---')
if len(parts) < 3:
    print('[]')
    sys.exit(0)
fm = parts[1]
files = []
for line in fm.splitlines():
    if '  - file:' in line:
        files.append(line.split('file:', 1)[1].strip())
print(json.dumps(files))
PYEOF
)

NEW_ENTRY=$(python3 -c "
import json
entry = {
    'ts': '$TS',
    'type': 'daemon-synthesis',
    'source': '$INPUT_SOURCE',
    'session_id': '$SESSION_ID',
    'synthesized_by': '$SYNTHESIZED_BY',
    'approved_by': '$GH_USERNAME',
    'profile': '${DRAFT_ACTIVE_PROFILE}',
    'files': json.loads('''$UPDATED_FILES''')
}
print(json.dumps(entry))
")

printf '%s\n' "$NEW_ENTRY" >> "$CHANGES_FILE"
_log "wrote CHANGES.jsonl entry (type=daemon-synthesis source=$INPUT_SOURCE)"

# ── Commit and push ────────────────────────────────────────────────────────────
if [ "$TEAM_REPO_SUBDIR" = "root" ]; then
    git -C "$TMPDIR" add context/ config/ CHANGES.jsonl 2>/dev/null || true
else
    git -C "$TMPDIR" add "$TEAM_REPO_SUBDIR/" 2>/dev/null || true
fi

COMMIT_MSG="daemon synthesis: ${INPUT_SOURCE} session ${SESSION_ID:0:8}"
git -C "$TMPDIR" commit -m "$COMMIT_MSG" --quiet 2>&1 | while IFS= read -r line; do _log "  git: $line"; done

git -C "$TMPDIR" push --quiet 2>&1 | while IFS= read -r line; do _log "  git push: $line"; done
PUSH_EXIT=$?

if [ $PUSH_EXIT -ne 0 ]; then
    _fail "git push failed — context was updated locally but not pushed"
fi

_log "pushed to $TEAM_REPO_URL"
exit 0
