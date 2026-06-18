# Intelligence Adapter Interface Contract

Files in `intelligence/` are **intelligence adapters** — each one knows how to
execute a specific LLM or agent tool to run synthesis.

Intelligence adapters are NOT aware of input source type (session vs Granola vs Slack).
They receive a pre-built prompt file and an output file path, execute the model,
and write the synthesis result to the output file.

## Directory layout

```
intelligence/
  claude-code.sh   # SHIPPED: Claude Code TUI via tmux (full agent loop, no per-token cost)
  codex.sh         # future: OpenAI Codex CLI (validate if tmux needed first)
  claude-api.sh    # deferred: stateless curl/claude -p — needs a real harness before it's useful
  openai-api.sh    # deferred: OpenAI API via curl
```

## Interface

### Input
```
$1 = prompt_file   — path to the synthesis task (plain text instructions for the LLM)
$2 = output_file   — path where the LLM should write its synthesis document
```

The prompt_file is written by the source adapter (synthesizers/*.sh). It contains:
- The synthesis task instructions
- Paths to files the LLM should read (transcript, workspace context)
- The exact output format required
- The output file path ($2) so the LLM knows where to write

### Output
```
stdout = empty (output is written to $2, not stdout)
```

The intelligence adapter writes synthesis output to `$2` (output_file).
The source adapter reads `$2` after the call and forwards it to stdout.

### Exit codes
- `exit 0` — success; output_file has been written with valid content
- `exit 1` — failure (model error, timeout, empty output, unexpected interactive prompt)

### Stderr
All log lines go to stderr. synthesize.sh captures them to background/logs/.

## Phase 1: claude-code.sh (tmux TUI)

The Phase 1 adapter runs Claude Code inside a detached tmux session. Key design decisions:

**Why full TUI, not `claude -p`:**
- Full TUI supports AskUserQuestion tool — Phase 4+ human-in-the-loop synthesis
  will route questions from the synthesis session to the user via notification/Slack/desktop
- Full agent loop (Read, Write, subagents) for complex multi-step synthesis
- No per-token billing (uses existing Claude Code subscription)

**Phase 1 headless constraint:**
The synthesis prompt instructs Claude not to ask questions. If `❯` (Claude waiting
for input) is detected before the output_file is written, it means Claude asked a
question or stalled — the adapter exits 1 and the job moves to failed/.

**tmux orchestration (self-contained in claude-code.sh):**
1. Spawn detached tmux session
2. Launch `claude --dangerously-skip-permissions` in the workspace directory
3. Handle trust dialog (Enter) and permissions dialog (Down → Enter) via send-keys
4. Send the synthesis task: "Follow instructions at $1. Write output to $2."
5. Poll `tmux capture-pane` every 5 seconds for `❯` (Claude waiting = task complete)
6. Check output_file exists → exit 0. Doesn't exist → exit 1.
7. Kill tmux session and clean up temp files

**Phase 4+ human-in-the-loop path (not Phase 1):**
When `❯` is detected AND output_file does not exist, Claude is asking a question.
Future: capture pane content, write question to `~/.draft/background/pending-questions/`,
poll for answer file, send answer via send-keys, resume. Python rewrite recommended
for this — TmuxSession class + ClaudeCodeAdapter class.

## Hook suppression contract

Any intelligence adapter that launches a Claude Code (or other agent) session with
Draft hooks enabled **must** export `DRAFT_SUPPRESS_SESSION_END_HOOK=1` in the
agent's environment before launching. This prevents the synthesis session from
recursively enqueuing new jobs via `on-session-end.sh` when it exits.

`claude-code.sh` sets this in the generated launch script. Future adapters that
spawn agent sessions must do the same.

## Adding a new intelligence adapter

1. Create `intelligence/<name>.sh`
2. Accept `$1` = prompt_file, `$2` = output_file
3. Execute the model with the prompt
4. **Export `DRAFT_SUPPRESS_SESSION_END_HOOK=1`** if the model runs inside a session that has Draft hooks
5. Write synthesis output to `$2`
6. Exit 0 on success, exit 1 on failure
7. Log to stderr

Note on Codex: `codex exec --full-auto` may run headlessly without tmux.
Validate before building `intelligence/codex.sh`.
