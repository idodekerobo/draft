#!/bin/bash
# draft-daemon.sh — Draft background daemon
#
# Runs as a LaunchAgent (always-on, auto-restart via KeepAlive).
# Event loop: polls pending/ for session-end job files, processes them.
#
# Phase 0: validate + log jobs. Synthesis added in Phase 1.
# Phase 1: route to synthesize.sh → proposals/ → curator approve → GitHub
# Phase 2+: granola_poll_loop, slack_poll_loop added here
#
# Logs: structured JSON to ~/.draft/background/logs/daemon.log
# stdout/stderr are captured by LaunchAgent to logs/daemon.log / logs/daemon-error.log

DRAFT_GLOBAL="$HOME/.draft"
DRAFT_BACKGROUND="$DRAFT_GLOBAL/background"
CONFIG="$DRAFT_BACKGROUND/config.sh"

# Load config — abort if missing (daemon cannot run without it)
if [ ! -f "$CONFIG" ]; then
    echo "[draft-daemon] ERROR: config.sh not found at $CONFIG — daemon cannot start" >&2
    exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG"

# Ensure runtime directories exist
mkdir -p "$DRAFT_PENDING" "$DRAFT_FAILED" "$DRAFT_LOGS"

LOG="$DRAFT_LOGS/daemon.log"
MAX_LOG_LINES=10000   # trim when log exceeds this; keep last 5000

# ── Logging ────────────────────────────────────────────────────────────────────
_log() {
    local level="$1" msg="$2"
    local ts
    ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    printf '{"ts":"%s","level":"%s","msg":"%s"}\n' "$ts" "$level" "$msg" >> "$LOG"
}

_trim_log() {
    if [ -f "$LOG" ]; then
        local lines
        lines=$(wc -l < "$LOG" | tr -d ' ')
        if [ "$lines" -gt "$MAX_LOG_LINES" ]; then
            tail -5000 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
            _log "info" "log trimmed (${lines} -> 5000 lines)"
        fi
    fi
}

# ── Job processing ─────────────────────────────────────────────────────────────
_process_job() {
    local job_file="$1"
    local job_name
    job_name=$(basename "$job_file")

    _log "info" "processing job: $job_name"

    # Validate JSON — malformed files go to failed/
    if ! python3 -c "import json,sys; json.load(open('$job_file'))" 2>/dev/null; then
        _log "error" "invalid JSON in $job_name — quarantining to failed/"
        mv "$job_file" "$DRAFT_FAILED/$job_name"
        return 1
    fi

    # Extract fields from job payload
    local job_profile job_session_id job_project_id job_timestamp
    job_profile=$(python3 -c "
import json
d = json.load(open('$job_file'))
print(d.get('profile', 'default'))
" 2>/dev/null || echo "default")

    job_session_id=$(python3 -c "
import json
d = json.load(open('$job_file'))
print(d.get('session_id', 'unknown'))
" 2>/dev/null || echo "unknown")

    _log "info" "job $job_name: profile=$job_profile session_id=$job_session_id"

    # Phase 1: route to synthesize.sh → proposals/ → curator approves → GitHub
    if [ -x "$DRAFT_BACKGROUND/synthesize.sh" ]; then
        if bash "$DRAFT_BACKGROUND/synthesize.sh" "$job_file"; then
            rm -f "$job_file"
            _log "info" "job $job_name complete"
            return 0
        else
            _log "error" "synthesize.sh failed for $job_name — quarantining to failed/"
            mv "$job_file" "$DRAFT_FAILED/$job_name"
            return 1
        fi
    else
        # synthesize.sh not installed — phase-0 fallback
        _log "warn" "synthesize.sh not found — phase-0 fallback (job logged and removed)"
        rm -f "$job_file"
        return 0
    fi
}

# ── Main event loop ────────────────────────────────────────────────────────────
_log "info" "draft daemon starting (pid=$$, profile=$DRAFT_ACTIVE_PROFILE, pending_poll=${DRAFT_PENDING_POLL}s)"

LOOP_COUNT=0
LAST_GRANOLA_POLL=0     # epoch seconds; 0 = never polled this session
LAST_SLACK_MANAGER=0    # process health check every 60s
LAST_SLACK_ANALYSIS=0   # synthesis batch every DRAFT_SLACK_ANALYSIS seconds
LAST_GITHUB_POLL=0      # epoch seconds; 0 = never polled this session
SLACK_MANAGER_INTERVAL=60

while true; do

    # -- Process pending jobs --------------------------------------------------
    for job_file in "$DRAFT_PENDING"/*.json; do
        # Guard: glob returns literal pattern when no files match
        [ -f "$job_file" ] || continue
        _process_job "$job_file" || _log "warn" "job handler returned error for $(basename "$job_file")"
    done

    # -- Phase 2: Granola poller -----------------------------------------------
    # Runs granola-poller.sh asynchronously on DRAFT_GRANOLA_POLL interval.
    # The poller manages its own state (background/state/granola.json) and
    # writes proposals directly — it does not go through the pending/ queue.
    # Async (&) so a slow synthesis call never blocks job queue processing.
    if [ -x "$DRAFT_BACKGROUND/integrations/granola/granola-poller.sh" ]; then
        _NOW=$(date +%s)
        if [ $((_NOW - LAST_GRANOLA_POLL)) -ge "$DRAFT_GRANOLA_POLL" ]; then
            _log "info" "granola: starting poll (interval=${DRAFT_GRANOLA_POLL}s mode=${DRAFT_GRANOLA_MODE})"
            bash "$DRAFT_BACKGROUND/integrations/granola/granola-poller.sh" >> "$DRAFT_LOGS/daemon.log" 2>&1 &
            LAST_GRANOLA_POLL=$_NOW
        fi
    fi

    # -- Phase 3: Slack manager (process health check every 60s) ---------------
    # Ensures slack-capture.ts is running if Slack is configured.
    if [ -x "$DRAFT_BACKGROUND/integrations/slack/slack-manager.sh" ]; then
        _NOW=$(date +%s)
        if [ $((_NOW - LAST_SLACK_MANAGER)) -ge "$SLACK_MANAGER_INTERVAL" ]; then
            bash "$DRAFT_BACKGROUND/integrations/slack/slack-manager.sh" >> "$DRAFT_LOGS/daemon.log" 2>&1
            LAST_SLACK_MANAGER=$_NOW
        fi
    fi

    # -- Phase 3: Slack analyzer (synthesis every DRAFT_SLACK_ANALYSIS seconds) -
    # Reads captured Slack messages, reconstructs threads, synthesizes proposals.
    if [ -x "$DRAFT_BACKGROUND/integrations/slack/slack-analyzer.sh" ]; then
        _NOW=$(date +%s)
        if [ $((_NOW - LAST_SLACK_ANALYSIS)) -ge "$DRAFT_SLACK_ANALYSIS" ]; then
            _log "info" "slack: starting analysis (interval=${DRAFT_SLACK_ANALYSIS}s)"
            bash "$DRAFT_BACKGROUND/integrations/slack/slack-analyzer.sh" >> "$DRAFT_LOGS/daemon.log" 2>&1 &
            LAST_SLACK_ANALYSIS=$_NOW
        fi
    fi

    # -- GitHub poller --------------------------------------------------------
    _NOW=$(date +%s)
    if [ $((_NOW - LAST_GITHUB_POLL)) -ge "${DRAFT_GITHUB_POLL:-3600}" ]; then
        if [ -f "$DRAFT_WORKSPACE/config/github.json" ] && \
           [ -x "$DRAFT_BACKGROUND/integrations/github/github-poller.sh" ]; then
            _log "info" "github: starting poll (interval=${DRAFT_GITHUB_POLL}s)"
            bash "$DRAFT_BACKGROUND/integrations/github/github-poller.sh" >> "$DRAFT_LOGS/daemon.log" 2>&1 &
        fi
        LAST_GITHUB_POLL=$_NOW
    fi

    # -- Periodic log trim (every 1000 loops) ----------------------------------
    LOOP_COUNT=$((LOOP_COUNT + 1))
    if [ $((LOOP_COUNT % 1000)) -eq 0 ]; then
        _trim_log
    fi

    sleep "$DRAFT_PENDING_POLL"
done
