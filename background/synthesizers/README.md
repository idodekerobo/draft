# Source Adapter Interface Contract

These source adapters describe the local/background synthesis runtime contract. The current hosted architecture stores source items and context versions in the backend workspace and runs production synthesis through the backend's sandbox orchestration. Keep this document for the local runtime and self-hosting implementation details; it is not a description of the hosted collaboration model.

This local contract predates the hosted result shape in the backend. Its `needs_input` outcome stages a local flagged proposal, while hosted synthesis stores a `needs_input` array on the synthesis run and may persist it alongside a changed or unchanged result. Do not use this local `proposals/flagged/` behavior as the hosted product workflow.

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
  maintainer-contract.ts     # shared outcome contract, imported by every adapter
  synthesis-runtime.ts       # context snapshots + intelligence invocation
  claude-code-session.ts     # Claude Code session transcripts
  codex-session.ts           # Codex session transcripts
  granola.ts                 # Granola meeting transcripts
  fireflies.ts               # Fireflies meeting transcripts
  slack.ts                   # Slack message batches
  github.ts                  # merged PRs and releases
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

Every adapter emits a single YAML frontmatter block declaring exactly one outcome.
The adapter never writes to `context/` itself — the host validates this document and
performs any write. Adapters get the outcome rules by calling
`buildMaintainerContractPrompt()` from `maintainer-contract.ts`; do not hand-write
them per source.

### Outcomes

| Outcome | Meaning | What the host does |
|---|---|---|
| `no_change` | Nothing durable happened. The most common real result. | Records a clean run. Nothing is written. |
| `rewrite` | Existing context is now out of date. | Verifies each target's hash, replaces the whole file atomically, snapshots before/after, writes a dimension log entry. |
| `needs_input` | A named contradiction that cannot be safely reconciled from the evidence. | Stages one item under `proposals/flagged/`. No context file is touched. |

`no_change` carries neither `rewrites` nor `needs_input_reason`. `needs_input` carries
only a reason. `rewrite` carries at least one entry whose `file` is an existing
`context/<dimension>/index.md`, whose `base_sha256` is copied verbatim from the host's
supplied snapshot hash, and whose `content` is the complete replacement document
rather than a patch.

```markdown
---
session_id: 853ea41f
input_source: session
synthesized_by: claude-code
timestamp: 2026-05-17T02:44:08Z
profile: draft-pm-agent
outcome: rewrite
rewrites:
  - file: context/product/index.md
    base_sha256: <the host_sha256 supplied for that file>
    summary: |
      Recorded the separate-clone pattern for GitHub publishing; dropped the note
      that the approach was still undecided.
    removals:
      - claim: "publishing approach still undecided"
        reason: "settled this session — separate clone avoids git init in the workspace"
    content: |
      [complete new content for context/product/index.md]
---
```

Meeting sources (`granola`, `fireflies`) must additionally emit a `meeting_ids` list
for every outcome — it is how the poller advances its cursor. An empty list is valid.

Contradictions are no longer routed to `context/tensions.md`; an unresolved one is
`needs_input`. Adapters must never write to `context/tensions.md` — the snapshot they
receive is read-only conflict evidence.

### Exit codes
- `exit 0` — success; `synthesize.ts` validates and routes stdout
- `exit 1` — failure; `synthesize.ts` moves the job to `background/failed/`

### Stderr
All log lines go to stderr. `synthesize.ts` captures them to `background/logs/`.

## Calling the intelligence adapter

Source adapters call intelligence adapters to execute the LLM. Each source has
its own intelligence config var — use the one for your source, not a generic one:

| Source adapter | Intelligence var | Default |
|---|---|---|
| `claude-code-session.ts`, `codex-session.ts` | `DRAFT_SESSION_INTELLIGENCE` | `claude-code` |
| `granola.ts` | `DRAFT_GRANOLA_INTELLIGENCE` | `claude-code` |
| `fireflies.ts` | `DRAFT_FIREFLIES_INTELLIGENCE` | `claude-code` |
| `slack.ts` | `DRAFT_SLACK_INTELLIGENCE` | `claude-code` |
| `github.ts` | `DRAFT_GITHUB_INTELLIGENCE` | `claude-code` |

Override via environment variable. The same value is recorded as `synthesized_by` on
the resulting run, so it must be read from the env rather than hardcoded.

Valid values: `claude-code` (tmux TUI, full tool access), `claude-api` (stateless curl, faster/cheaper), `codex` (future).

```ts
// Use the var for YOUR source — not DRAFT_SESSION_INTELLIGENCE
const intelligence = process.env.DRAFT_GRANOLA_INTELLIGENCE ?? 'claude-code';
const snapshot = createContextSnapshot(workspace);
try {
  return await runIntelligence({
    adapterPath: resolveIntelligenceAdapter(backgroundDir, intelligence, deps.exists),
    prompt: buildMyPrompt({ /* source evidence */ snapshot, outputPath, intelligence }),
    outputPath,
  }, deps);
} finally {
  cleanupContextSnapshot(snapshot);
  rmSync(outputPath, { force: true });
}
```

See `intelligence/README.md` for the intelligence adapter contract.

## Adding a new source adapter

1. Create `synthesizers/<source>.ts` exporting a `build<Source>Prompt()` and a
   `run<Source>()`, so the prompt is testable without spawning a model.
2. Register it in `SYNTHESIS_ADAPTERS` in `background/synthesize.ts`, or call it from
   your poller.
3. Add a `DRAFT_<SOURCE>_INTELLIGENCE` env var following the table above.
4. Take a context snapshot with `createContextSnapshot()` and clean it up in a
   `finally` — the snapshot hashes are what make a rewrite's `base_sha256` verifiable.
5. Describe only your source's evidence in the prompt, then append
   `buildMaintainerContractPrompt()` for the outcome rules. Never restate the outcome
   contract yourself; it drifts.
6. Write output to `$DRAFT_WORKSPACE/tmp/<source>-…` (not `/tmp/` — Claude Code cannot
   write there) and return its contents.
7. Route the result through `routeAutomatedMaintainerOutput()`. Never write to
   `context/` from an adapter.
