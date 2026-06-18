#!/bin/bash
# intelligence/claude-code.sh — Claude Code intelligence adapter (tmux TUI)
#
# Executes synthesis by running Claude Code inside a detached tmux session.
# Uses the full TUI (not -p) to preserve AskUserQuestion forwarding path (Phase 4+).
# Phase 1 constraint: synthesis prompt instructs Claude not to ask questions.
#
# See intelligence/README.md for full contract.
#
# Usage: bash intelligence/claude-code.sh <prompt_file> <output_file>
#   prompt_file  — complete synthesis task instructions (written by source adapter)
#   output_file  — where Claude should write its synthesis .md document

set -uo pipefail

PROMPT_FILE="$1"
OUTPUT_FILE="$2"

DRAFT_BACKGROUND="$HOME/.draft/background"
# shellcheck source=../config.sh
source "$DRAFT_BACKGROUND/config.sh"

# ── Expand PATH for LaunchAgent environment ────────────────────────────────────
# LaunchAgent runs with a minimal PATH that excludes user-installed tools.
# Prepend common install locations for claude and tmux.
export PATH="$HOME/.draft/bin:$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

_log() {
    printf '[claude-code.sh] %s\n' "$*" >&2
}

# ── Validate inputs ────────────────────────────────────────────────────────────
if [ ! -f "$PROMPT_FILE" ]; then
    _log "ERROR: prompt_file not found: $PROMPT_FILE"
    exit 1
fi

if [ -z "$OUTPUT_FILE" ]; then
    _log "ERROR: output_file path required as \$2"
    exit 1
fi

# ── Check dependencies ─────────────────────────────────────────────────────────
if ! command -v claude &>/dev/null; then
    _log "ERROR: claude not found — install Claude Code CLI"
    exit 1
fi

if ! command -v tmux &>/dev/null; then
    _log "ERROR: tmux not found — install via: brew install tmux"
    exit 1
fi

# ── Session name (unique per synthesis run) ────────────────────────────────────
# Use PID + epoch seconds — avoids collision if two syntheses run simultaneously.
TMUX_SESSION="draft-synth-$$-$(date +%s)"

# ── Write launch script ────────────────────────────────────────────────────────
# Writing to a script file avoids send-keys quoting/escaping issues.
LAUNCH_SCRIPT=$(mktemp /tmp/draft-launch-XXXXXX)

cat > "$LAUNCH_SCRIPT" <<LAUNCH
#!/bin/bash
# Draft synthesis launch — spawned by daemon
cd "\${DRAFT_WORKSPACE:-$DRAFT_WORKSPACE}"
exec claude --dangerously-skip-permissions
LAUNCH
chmod +x "$LAUNCH_SCRIPT"

# ── Trace log path ─────────────────────────────────────────────────────────────
# Written on every run. Named by session so multiple concurrent synths don't clobber.
# Read with: cat ~/.draft/background/logs/synth-trace-<session>.log
TRACE_LOG="$DRAFT_LOGS/synth-trace-${TMUX_SESSION}.log"

# ── Cleanup on exit ────────────────────────────────────────────────────────────
# Capture full pane history BEFORE killing — once killed, pane is gone.
_cleanup() {
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
        tmux capture-pane -t "$TMUX_SESSION" -p -S -5000 2>/dev/null > "$TRACE_LOG" || true
        _log "trace saved → $TRACE_LOG"
        tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    fi
    rm -f "$LAUNCH_SCRIPT"
}
trap _cleanup EXIT

# ── Spawn tmux session ─────────────────────────────────────────────────────────
_log "spawning tmux session: $TMUX_SESSION"
tmux new-session -d -s "$TMUX_SESSION" -x 220 -y 50 2>/dev/null || {
    _log "ERROR: failed to create tmux session (session name conflict?)"
    exit 1
}

# ── Launch Claude Code ─────────────────────────────────────────────────────────
tmux send-keys -t "$TMUX_SESSION" "bash '$LAUNCH_SCRIPT'" Enter
_log "launched claude, handling startup dialogs..."

# Dialog 1: Workspace Trust — "Yes, I trust this folder" is the default (Enter)
# Only appears on first visit to this directory; safe to send regardless.
sleep 4
tmux send-keys -t "$TMUX_SESSION" Enter

# Dialog 2: Bypass Permissions Warning (--dangerously-skip-permissions)
# Default is "No, exit" — must navigate Down to "Yes, I accept" then Enter
sleep 3
tmux send-keys -t "$TMUX_SESSION" Down
sleep 0.3
tmux send-keys -t "$TMUX_SESSION" Enter

# Wait for Claude startup to settle (welcome screen renders)
sleep 3
_log "startup complete, sending synthesis task"

# ── Send synthesis task ────────────────────────────────────────────────────────
# Short message pointing Claude to the prompt file. Avoids long send-keys strings.
# Claude will use its Read tool to load the instructions, then follow them.
TASK_MSG="Read the synthesis instructions at '${PROMPT_FILE}' and follow them exactly. Write your output to '${OUTPUT_FILE}'. Do not ask questions or seek clarification — if anything is ambiguous, omit it."
tmux send-keys -t "$TMUX_SESSION" -l "$TASK_MSG"
sleep 0.5
tmux send-keys -t "$TMUX_SESSION" Enter

_log "task sent, monitoring for completion..."

# Checkpoint: capture pane 3s after submit to verify Claude started processing
sleep 3
CHECKPOINT=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -10 2>/dev/null || echo "")
_log "post-submit checkpoint (3s):"
echo "$CHECKPOINT" | tail -8 | while IFS= read -r line; do
    _log "  pane: $line"
done

# ── Poll for completion ────────────────────────────────────────────────────────
# Success condition: '❯' in last 5 pane lines (Claude at input prompt) AND
# output_file exists with content (Claude wrote the synthesis document).
#
# Checking BOTH conditions prevents false positives:
# - Initial startup ❯ (file doesn't exist yet) → loop continues
# - Claude working (no ❯) → loop continues
# - Claude asking a question instead of writing (❯, no file) → loop continues → timeout
# - Claude done (❯ + file written) → exit loop ✓
#
# Max wait: 280s (parent synthesize.sh watchdog has a 300s limit — leave buffer).
ELAPSED=0
MAX_WAIT=280
POLL_INTERVAL=10

while [ "$ELAPSED" -lt "$MAX_WAIT" ]; do
    sleep "$POLL_INTERVAL"
    ELAPSED=$((ELAPSED + POLL_INTERVAL))

    PANE=$(tmux capture-pane -t "$TMUX_SESSION" -p -S -5 2>/dev/null || echo "")
    PROMPT_VISIBLE=$(echo "$PANE" | grep -c "❯" || true)
    FILE_READY=$([ -f "$OUTPUT_FILE" ] && [ -s "$OUTPUT_FILE" ] && echo "yes" || echo "no")

    if [ "$PROMPT_VISIBLE" -gt 0 ] && [ "$FILE_READY" = "yes" ]; then
        _log "synthesis complete: output file written + Claude at prompt (${ELAPSED}s)"
        break
    fi

    # Log periodic progress for debugging
    if [ $((ELAPSED % 30)) -eq 0 ]; then
        _log "still waiting... (${ELAPSED}s, file_ready=$FILE_READY)"
    fi
done

if [ "$ELAPSED" -ge "$MAX_WAIT" ]; then
    _log "ERROR: timed out after ${MAX_WAIT}s waiting for synthesis completion"
    exit 1
fi

# ── Validate output ────────────────────────────────────────────────────────────
if [ ! -f "$OUTPUT_FILE" ]; then
    _log "ERROR: output_file not written (Claude may have asked a question or stalled)"
    _log "Phase 1: interactive synthesis not supported — job will move to failed/"
    # Capture last pane content for debugging
    tmux capture-pane -t "$TMUX_SESSION" -p -S -20 2>/dev/null | while IFS= read -r line; do
        _log "  pane: $line"
    done
    exit 1
fi

if [ ! -s "$OUTPUT_FILE" ]; then
    _log "ERROR: output_file is empty"
    exit 1
fi

_log "synthesis complete — output written to $OUTPUT_FILE"
exit 0
