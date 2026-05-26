# Source Adapter Interface Contract

Files in `synthesizers/` are **source adapters** — each one knows how to handle
a specific input source (session transcripts, Granola meetings, Slack threads).

Source adapters are responsible for:
- Reading and parsing the input for their source type
- Building the synthesis prompt (including all context the intelligence needs)
- Calling the configured intelligence adapter
- Returning the final synthesis document on stdout

## Directory layout

```
synthesizers/
  claude-code-session.sh     # Claude Code session transcripts
  granola.sh     # Granola meeting transcripts
  slack.sh       # Slack message batches
```

## Interface

### Input
```
$1 = path to job file (JSON)
```

Job file schema (written by on-session-end.sh, confirmed 2026-05-17):
```json
{
  "profile":         "draft-pm-agent",
  "session_id":      "853ea41f-09ef-47d7-a1fa-502c16fc227d",
  "transcript_path": "/Users/.../.claude/projects/<slug>/<uuid>.jsonl",
  "cwd":             "/path/to/project",
  "reason":          "prompt_input_exit",
  "timestamp":       "2026-05-17T02:44:08Z"
}
```

### Output
```
stdout = .md file with YAML frontmatter
```

The output document has two layers:
1. **YAML frontmatter** — machine-parseable structured data for commit-to-team-context.sh
2. **Markdown body** — human-readable curator preview in proposals/

```markdown
---
session_id: 853ea41f
input_source: session
synthesized_by: claude-code
timestamp: 2026-05-17T02:44:08Z
profile: draft-pm-agent
context_updates:
  - file: context/product/index.md
    action: append
    content: |
      Decided to use separate-clone pattern for GitHub publishing...
  - file: context/tensions.md
    action: tension
    content: |
      ### Target user contradiction
      - **Observed:** 2026-05-17
      - **Signal:** Session says "targeting music directors" but context/product/index.md says "targeting composers"
      - **Status:** unresolved
      - **Resolution:**
---

## Synthesis preview

### context/product/index.md — append
Decided to use separate-clone pattern for GitHub publishing...

### context/tensions.md — tension
Target user contradiction: session says "targeting music directors" but product/index.md says "targeting composers"
```

### Action types

| Action | Meaning | Handler behaviour |
|---|---|---|
| `append` | New information that complements existing context | Appended to `file` |
| `tension` | New info contradicts existing context | Always appended to `context/tensions.md` regardless of `file` field. The `file` field is metadata only — it describes which dimension the contradiction relates to. |
| `overwrite` | Full file replacement | Replaces `file` contents. **Do not use in synthesis prompts** — reserved for curator-triggered compaction only. |

### Exit codes
- `exit 0` — success; synthesize.sh writes stdout to proposals/
- `exit 1` — failure; synthesize.sh moves job to background/failed/

### Stderr
All log lines go to stderr. synthesize.sh captures them to background/logs/.

## Calling the intelligence adapter

Source adapters call intelligence adapters to execute the LLM. Each source has
its own intelligence config var — use the one for your source, not a generic one:

| Source adapter | Intelligence var | Default |
|---|---|---|
| `claude-code-session.sh` | `DRAFT_SESSION_INTELLIGENCE` | `claude-code` |
| `granola.sh` | `DRAFT_GRANOLA_INTELLIGENCE` | `claude-code` |
| `slack.sh` | `DRAFT_SLACK_INTELLIGENCE` | `claude-code` |

All three vars are exported by `config.sh`. Override via environment variable.

Valid values: `claude-code` (tmux TUI, full tool access), `claude-api` (stateless curl, faster/cheaper), `codex` (future).

```bash
# Use the var for YOUR source — not DRAFT_SESSION_INTELLIGENCE
INTELLIGENCE="${DRAFT_GRANOLA_INTELLIGENCE:-claude-code}"
INTELLIGENCE_SCRIPT="$DRAFT_BACKGROUND/intelligence/${INTELLIGENCE}.sh"

if [ ! -x "$INTELLIGENCE_SCRIPT" ]; then
    _log "ERROR: intelligence adapter not found: $INTELLIGENCE_SCRIPT"
    exit 1
fi

bash "$INTELLIGENCE_SCRIPT" "$PROMPT_FILE" "$OUTPUT_FILE"
```

See `intelligence/README.md` for the intelligence adapter contract.

## Adding a new source adapter

1. Create `synthesizers/<source>.sh`
2. Source `config.sh` for paths and env vars
3. Accept `$1` as job file path
4. Add a `DRAFT_<SOURCE>_INTELLIGENCE` var to `config.sh` (follow the existing pattern)
5. Build a prompt file containing all synthesis instructions
6. Create a temp output file path at `$DRAFT_WORKSPACE/tmp/<source>-output-XXXX.md` (not /tmp/ — Claude Code cannot write there)
7. Call `intelligence/${DRAFT_<SOURCE>_INTELLIGENCE}.sh "$PROMPT_FILE" "$OUTPUT_FILE"`
8. On success: `cat "$OUTPUT_FILE"` to stdout, exit 0
9. On failure: log to stderr, exit 1
