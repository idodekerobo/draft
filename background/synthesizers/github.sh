#!/usr/bin/env bash
# github.sh — synthesizes GitHub activity into workspace context proposals
# Called by github-poller.sh with a context JSON file
set -uo pipefail

CONTEXT_FILE="$1"

DRAFT_BACKGROUND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DRAFT_BACKGROUND/config.sh"

_log() {
    printf '[github.sh] %s\n' "$*" >&2
}

# ── Resolve intelligence adapter ──────────────────────────────────────────────
INTELLIGENCE="${DRAFT_GITHUB_INTELLIGENCE:-claude-code}"
INTELLIGENCE_SCRIPT="$DRAFT_BACKGROUND/intelligence/${INTELLIGENCE}.sh"

if [ ! -x "$INTELLIGENCE_SCRIPT" ]; then
    _log "ERROR: intelligence adapter not found: $INTELLIGENCE_SCRIPT"
    exit 1
fi

# ── Parse context ─────────────────────────────────────────────────────────────
PROFILE=$(python3 -c "import json; d=json.load(open('$CONTEXT_FILE')); print(d.get('profile','default'))" 2>/dev/null || echo "default")
WORKSPACE="$HOME/.draft/workspaces/$PROFILE"

# ── Load team profiles (username → display name) ──────────────────────────────
TEAM_PROFILES_FILE="$WORKSPACE/config/team-profiles.json"
TEAM_PROFILES_MAP=""
if [ -f "$TEAM_PROFILES_FILE" ]; then
    TEAM_PROFILES_MAP=$(python3 - <<PYEOF
import json
try:
    profiles = json.load(open("$TEAM_PROFILES_FILE"))
    lines = []
    for p in profiles:
        github = p.get("github", "")
        name = p.get("name", github)
        slack = p.get("slack", "")
        if github:
            slack_str = f" (Slack: {slack})" if slack else ""
            lines.append(f"  - {github} -> {name}{slack_str}")
    print("\n".join(lines) if lines else "  (no team profiles configured)")
except Exception:
    print("  (team-profiles.json not readable)")
PYEOF
)
else
    TEAM_PROFILES_MAP="  (not configured — run /draft:connect github to add team member mappings)"
fi

# ── Discover workspace context files ─────────────────────────────────────────
CONTEXT_FILES_LIST=$(find "$WORKSPACE/context" -maxdepth 2 -name "index.md" 2>/dev/null | sort | \
    while read -r f; do printf '   - %s\n' "$f"; done)
[ -z "$CONTEXT_FILES_LIST" ] && CONTEXT_FILES_LIST="   (none found)"

# ── Format GitHub activity for prompt ────────────────────────────────────────
GITHUB_DATA=$(python3 - <<PYEOF
import json, sys

try:
    ctx = json.load(open("$CONTEXT_FILE"))
    profiles = []
    try:
        profiles = json.load(open("$TEAM_PROFILES_FILE"))
    except Exception:
        pass

    def resolve_name(gh_login):
        for p in profiles:
            if p.get("github", "").lower() == gh_login.lower():
                return p.get("name", gh_login)
        return gh_login

    lines = []

    merged = ctx.get("merged_prs", [])
    if merged:
        lines.append("### Merged PRs (shipped work)")
        for pr in merged:
            author = resolve_name(pr.get("author", {}).get("login", "unknown"))
            title = pr.get("title", "(no title)")
            num = pr.get("number", "?")
            repo = pr.get("repo", "")
            merged_at = pr.get("mergedAt", "")[:10] if pr.get("mergedAt") else ""
            body_preview = (pr.get("body") or "")[:200].strip().replace("\n", " ")
            lines.append(f"- [{repo}] #{num} by {author} on {merged_at}: {title}")
            if body_preview:
                lines.append(f"  Description: {body_preview}")
        lines.append("")

    releases = ctx.get("releases", [])
    if releases:
        lines.append("### New Releases")
        for r in releases:
            tag = r.get("tagName", "?")
            name = r.get("name", tag)
            published = r.get("publishedAt", "")[:10] if r.get("publishedAt") else ""
            repo = r.get("repo", "")
            lines.append(f"- [{repo}] {tag} ({name}) — published {published}")
        lines.append("")

    open_prs = ctx.get("open_prs", [])
    if open_prs:
        lines.append("### Open PRs (in-flight work)")
        for pr in open_prs:
            author = resolve_name(pr.get("author", {}).get("login", "unknown"))
            title = pr.get("title", "(no title)")
            num = pr.get("number", "?")
            repo = pr.get("repo", "")
            created = pr.get("createdAt", "")[:10] if pr.get("createdAt") else ""
            review = pr.get("reviewDecision", "") or "pending review"
            lines.append(f"- [{repo}] #{num} by {author} (opened {created}, {review}): {title}")
        lines.append("")

    print("\n".join(lines) if lines else "(no new GitHub activity)")
except Exception as e:
    print(f"(error formatting GitHub data: {e})", file=sys.stderr)
    print("(no data)")
PYEOF
)

# ── Build prompt ──────────────────────────────────────────────────────────────
PROMPT_FILE=$(mktemp /tmp/draft-github-prompt-XXXXXX.txt)
mkdir -p "$DRAFT_WORKSPACE/tmp"
OUTPUT_FILE=$(mktemp "$DRAFT_WORKSPACE/tmp/github-synthesis-XXXXXX")

_cleanup() { rm -f "$PROMPT_FILE"; }
trap _cleanup EXIT

cat > "$PROMPT_FILE" <<PROMPT
# Draft Synthesis Task — GitHub Activity

You are a context synthesis agent for Draft. Your job is to extract relevant signal from recent GitHub activity and propose updates to the team's workspace context.

## Team member profiles (GitHub username -> display name)
$TEAM_PROFILES_MAP

## Recent GitHub activity
$GITHUB_DATA

## Existing workspace context files
$CONTEXT_FILES_LIST

---

## Your task

Read the existing workspace context files to understand what's already captured. Then synthesize the GitHub activity above into context updates — focusing on what a product lead or engineering manager would care about.

**Signal that matters:**
- What shipped (merged PRs, releases) — who built it, what it does
- What's actively in progress (open PRs) — who's working on what, any obvious blockers (long-open PRs, no reviews)
- Release milestones

**Signal to ignore:**
- Low-signal PRs (dependency bumps, typo fixes, config changes)
- Activity that's already captured in existing context
- Open PRs that were just created today (too early to be meaningful)

**Rules:**
- Use display names from the team profile map, not raw GitHub usernames
- If a PR description clarifies what the feature does, include that context
- Do NOT repeat what's already in workspace context files
- If GitHub activity contradicts something in workspace context, use action: tension

## Output format

Write your output to: $OUTPUT_FILE

Use this exact YAML frontmatter followed by a markdown preview:

\`\`\`
---
input_source: github
synthesized_by: $INTELLIGENCE
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
profile: $PROFILE
context_updates:
  - file: context/product/index.md
    action: append
    content: |
      [your synthesized insight here]
---

## GitHub synthesis preview

[markdown summary of what was captured and why]
\`\`\`

If there is genuinely nothing relevant to capture, write:
\`\`\`
---
input_source: github
synthesized_by: $INTELLIGENCE
timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)
profile: $PROFILE
context_updates: []
---

No relevant GitHub activity to capture.
\`\`\`
PROMPT

# ── Call intelligence ─────────────────────────────────────────────────────────
_log "calling intelligence adapter: $INTELLIGENCE"
if ! bash "$INTELLIGENCE_SCRIPT" "$PROMPT_FILE" "$OUTPUT_FILE"; then
    _log "ERROR: intelligence adapter failed"
    exit 1
fi

if [ ! -s "$OUTPUT_FILE" ]; then
    _log "ERROR: intelligence adapter returned empty output"
    exit 1
fi

if ! head -1 "$OUTPUT_FILE" | grep -q '^---'; then
    _log "ERROR: output missing YAML frontmatter"
    exit 1
fi

# ── Emit to stdout ────────────────────────────────────────────────────────────
cat "$OUTPUT_FILE"
exit 0
