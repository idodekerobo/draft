#!/usr/bin/env bash
# github-poller.sh — polls GitHub for merged PRs, releases, and open PRs
# Called by draft-background.ts on DRAFT_GITHUB_POLL interval (default: 1 hour)
set -uo pipefail

DRAFT_BACKGROUND="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$DRAFT_BACKGROUND/config.sh"

STATE_FILE="$DRAFT_BACKGROUND/state/github.json"
SYNTHESIZER="$DRAFT_BACKGROUND/synthesizers/github.sh"

_log() {
    local level="$1" msg="$2"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"ts":"%s","level":"%s","component":"github-poller","msg":"%s"}\n' \
        "$ts" "$level" "$msg" >&2
}

# ── Guard: gh CLI authenticated? ─────────────────────────────────────────────
if ! gh auth status >/dev/null 2>&1; then
    _log "warn" "gh CLI not authenticated — skipping (run: gh auth login)"
    exit 0
fi

# ── Load repos from per-profile config ───────────────────────────────────────
GITHUB_CONFIG_FILE="$DRAFT_WORKSPACE/config/github.json"

if [ ! -f "$GITHUB_CONFIG_FILE" ]; then
    _log "info" "no github config found for profile '$DRAFT_ACTIVE_PROFILE' — skipping (run /draft:connect github to configure)"
    exit 0
fi

DRAFT_GITHUB_REPOS=$(python3 -c "
import json
try:
    d = json.load(open('$GITHUB_CONFIG_FILE'))
    repos = d.get('repos', [])
    print(' '.join(repos) if repos else '')
except Exception:
    print('')
" 2>/dev/null || echo "")

if [ -z "$DRAFT_GITHUB_REPOS" ]; then
    _log "info" "repos list is empty in github config — skipping"
    exit 0
fi

# ── Initialize state file ─────────────────────────────────────────────────────
if [ ! -f "$STATE_FILE" ]; then
    mkdir -p "$(dirname "$STATE_FILE")"
    printf '{"last_polled_at": null, "processed_pr_ids": [], "processed_release_tags": []}\n' > "$STATE_FILE"
fi

# ── Read state ────────────────────────────────────────────────────────────────
LAST_POLLED_AT=$(python3 -c "
import json
d = json.load(open('$STATE_FILE'))
v = d.get('last_polled_at')
print(v if v else '')
" 2>/dev/null || echo "")

PROCESSED_PR_IDS=$(python3 -c "
import json
d = json.load(open('$STATE_FILE'))
print(json.dumps(d.get('processed_pr_ids', [])))
" 2>/dev/null || echo "[]")

PROCESSED_RELEASE_TAGS=$(python3 -c "
import json
d = json.load(open('$STATE_FILE'))
print(json.dumps(d.get('processed_release_tags', [])))
" 2>/dev/null || echo "[]")

_log "info" "starting poll (last_polled=${LAST_POLLED_AT:-never}, repos=${DRAFT_GITHUB_REPOS})"

CURRENT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Fetch GitHub activity ─────────────────────────────────────────────────────
CONTEXT_FILE=$(mktemp /tmp/draft-github-context-XXXXXX)
trap 'rm -f "$CONTEXT_FILE"' EXIT

# Build per-repo data using gh CLI
python3 - <<PYEOF
import json, subprocess, sys

repos = "${DRAFT_GITHUB_REPOS}".split()
last_polled = "${LAST_POLLED_AT}" if "${LAST_POLLED_AT}" else None
processed_pr_ids = ${PROCESSED_PR_IDS}
processed_release_tags = ${PROCESSED_RELEASE_TAGS}

all_merged_prs = []
all_releases = []
all_open_prs = []
new_pr_ids = []
new_release_tags = []

for repo in repos:
    # Merged PRs
    try:
        result = subprocess.run(
            ["gh", "pr", "list", "--repo", repo, "--state", "merged",
             "--json", "number,title,body,author,mergedAt", "--limit", "20"],
            capture_output=True, text=True, check=True
        )
        prs = json.loads(result.stdout or "[]")
        for pr in prs:
            pr_num = pr.get("number")
            merged_at = pr.get("mergedAt", "")
            # Skip already processed
            if f"{repo}:{pr_num}" in processed_pr_ids:
                continue
            # Skip if older than last poll (when we have a timestamp)
            if last_polled and merged_at and merged_at < last_polled:
                continue
            pr["repo"] = repo
            all_merged_prs.append(pr)
            new_pr_ids.append(f"{repo}:{pr_num}")
    except Exception as e:
        print(f"warn: failed to fetch PRs for {repo}: {e}", file=sys.stderr)

    # Releases
    try:
        result = subprocess.run(
            ["gh", "release", "list", "--repo", repo,
             "--json", "tagName,name,publishedAt", "--limit", "5"],
            capture_output=True, text=True, check=True
        )
        releases = json.loads(result.stdout or "[]")
        for r in releases:
            tag = r.get("tagName", "")
            published_at = r.get("publishedAt", "")
            if f"{repo}:{tag}" in processed_release_tags:
                continue
            if last_polled and published_at and published_at < last_polled:
                continue
            r["repo"] = repo
            all_releases.append(r)
            new_release_tags.append(f"{repo}:{tag}")
    except Exception as e:
        print(f"warn: failed to fetch releases for {repo}: {e}", file=sys.stderr)

    # Open PRs (in-flight signal — always fetch, no dedup needed)
    try:
        result = subprocess.run(
            ["gh", "pr", "list", "--repo", repo, "--state", "open",
             "--json", "number,title,author,createdAt,reviewDecision", "--limit", "10"],
            capture_output=True, text=True, check=True
        )
        open_prs = json.loads(result.stdout or "[]")
        for pr in open_prs:
            pr["repo"] = repo
        all_open_prs.extend(open_prs)
    except Exception as e:
        print(f"warn: failed to fetch open PRs for {repo}: {e}", file=sys.stderr)

context = {
    "type": "github",
    "profile": "${DRAFT_ACTIVE_PROFILE}",
    "timestamp": "${CURRENT_TS}",
    "last_polled_at": last_polled,
    "repos": repos,
    "merged_prs": all_merged_prs,
    "releases": all_releases,
    "open_prs": all_open_prs,
    "new_pr_ids": new_pr_ids,
    "new_release_tags": new_release_tags,
}

with open("${CONTEXT_FILE}", "w") as f:
    json.dump(context, f, indent=2)

print(f"fetched: {len(all_merged_prs)} merged PRs, {len(all_releases)} releases, {len(all_open_prs)} open PRs")
PYEOF

# ── Check if there's anything new ────────────────────────────────────────────
HAS_NEW=$(python3 -c "
import json
d = json.load(open('${CONTEXT_FILE}'))
has_new = len(d.get('new_pr_ids', [])) > 0 or len(d.get('new_release_tags', [])) > 0
print('yes' if has_new else 'no')
" 2>/dev/null || echo "no")

if [ "$HAS_NEW" = "no" ]; then
    _log "info" "no new GitHub activity since last poll"
    # Still update last_polled_at
    python3 - <<PYEOF
import json
with open("${STATE_FILE}") as f:
    state = json.load(f)
state["last_polled_at"] = "${CURRENT_TS}"
with open("${STATE_FILE}", "w") as f:
    json.dump(state, f, indent=2)
PYEOF
    exit 0
fi

# ── Call synthesizer ──────────────────────────────────────────────────────────
SYNTH_OUTPUT=$(mktemp /tmp/draft-github-output-XXXXXX)
trap 'rm -f "$CONTEXT_FILE" "$SYNTH_OUTPUT"' EXIT

if ! bash "$SYNTHESIZER" "$CONTEXT_FILE" > "$SYNTH_OUTPUT"; then
    _log "error" "synthesizer failed"
    exit 1
fi

if [ ! -s "$SYNTH_OUTPUT" ]; then
    _log "info" "synthesizer returned empty output — nothing to stage"
    exit 0
fi

# Validate frontmatter
if ! head -1 "$SYNTH_OUTPUT" | grep -q '^---'; then
    _log "error" "synthesizer output missing YAML frontmatter"
    exit 1
fi

# ── Write proposal ────────────────────────────────────────────────────────────
STAGING_DIR="$DRAFT_STAGING"
mkdir -p "$STAGING_DIR"

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
STAGING_FILE="${STAGING_DIR}/${TIMESTAMP}-github.md"

cp "$SYNTH_OUTPUT" "$STAGING_FILE"
_log "info" "staged proposal: $STAGING_FILE"

# ── Update state ──────────────────────────────────────────────────────────────
python3 - <<PYEOF
import json

with open("${STATE_FILE}") as f:
    state = json.load(f)

with open("${CONTEXT_FILE}") as f:
    ctx = json.load(f)

state["last_polled_at"] = "${CURRENT_TS}"

existing_pr_ids = set(state.get("processed_pr_ids", []))
for pid in ctx.get("new_pr_ids", []):
    existing_pr_ids.add(pid)
state["processed_pr_ids"] = list(existing_pr_ids)

existing_tags = set(state.get("processed_release_tags", []))
for tag in ctx.get("new_release_tags", []):
    existing_tags.add(tag)
state["processed_release_tags"] = list(existing_tags)

with open("${STATE_FILE}", "w") as f:
    json.dump(state, f, indent=2)

print(f"state updated: {len(state['processed_pr_ids'])} PRs tracked, {len(state['processed_release_tags'])} releases tracked")
PYEOF

_log "info" "poll complete"
exit 0
