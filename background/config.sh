#!/bin/bash
# config.sh — Draft daemon configuration
#
# Source this file from other background scripts:
#   source "$(dirname "${BASH_SOURCE[0]}")/config.sh"
#
# Exports:
#   DRAFT_GLOBAL, DRAFT_ACTIVE_PROFILE, DRAFT_WORKSPACE
#   DRAFT_BACKGROUND, DRAFT_PENDING, DRAFT_FAILED, DRAFT_LOGS, DRAFT_STAGING
#   DRAFT_CONFIG, DRAFT_SECRETS, DRAFT_LOCAL
#   DRAFT_PENDING_POLL, DRAFT_GRANOLA_POLL, DRAFT_SLACK_CAPTURE, DRAFT_SLACK_ANALYSIS

DRAFT_GLOBAL="$HOME/.draft"
DRAFT_BACKGROUND="$DRAFT_GLOBAL/background"

# ── Active profile ─────────────────────────────────────────────────────────────
# Read ~/.draft/active-profile. Falls back to "default" if missing or empty.
DRAFT_ACTIVE_PROFILE="default"
_profile_file="$DRAFT_GLOBAL/active-profile"
if [ -f "$_profile_file" ]; then
    _read_profile=$(tr -d '[:space:]' < "$_profile_file")
    if [ -n "$_read_profile" ]; then
        DRAFT_ACTIVE_PROFILE="$_read_profile"
    fi
fi

# ── Paths ──────────────────────────────────────────────────────────────────────
DRAFT_WORKSPACE="$DRAFT_GLOBAL/workspaces/$DRAFT_ACTIVE_PROFILE"
DRAFT_PENDING="$DRAFT_BACKGROUND/pending"
DRAFT_FAILED="$DRAFT_BACKGROUND/failed"
DRAFT_LOGS="$DRAFT_BACKGROUND/logs"
DRAFT_STAGING="$DRAFT_WORKSPACE/proposals"

# Per-profile config files
DRAFT_CONFIG="$DRAFT_WORKSPACE/config"
DRAFT_SECRETS="$DRAFT_CONFIG/secrets.json"   # daemon-only creds (Slack, Granola)
DRAFT_LOCAL="$DRAFT_CONFIG/local.json"       # Gate B creds (GitHub token)

# ── Polling defaults ───────────────────────────────────────────────────────────
# All intervals are in seconds. Override via environment variable.
#
# DRAFT_PENDING_POLL   — how often to check pending/ queue          (default: 5s)
# DRAFT_GRANOLA_POLL   — how often to check for new Granola txcpts  (default: 15min)
# DRAFT_SLACK_CAPTURE  — how often to poll Slack REST API           (default: 5min)
# DRAFT_SLACK_ANALYSIS — how often to run Slack synthesis batch     (default: 4hr)

DRAFT_PENDING_POLL="${DRAFT_PENDING_POLL:-5}"
DRAFT_GRANOLA_POLL="${DRAFT_GRANOLA_POLL:-900}"
DRAFT_SLACK_CAPTURE="${DRAFT_SLACK_CAPTURE:-300}"
DRAFT_SLACK_ANALYSIS="${DRAFT_SLACK_ANALYSIS:-14400}"

# ── Per-source intelligence config ─────────────────────────────────────────────
# Which intelligence adapter each source uses for synthesis.
# All default to "claude-code". Override via environment variable.
#
# Valid values today: "claude-code" (tmux TUI, full tool access, no per-token cost)
#                     "codex"      (future: codex exec — validate headless behavior first)
# Deferred:           "claude-api", "openai-api" — stateless adapters need a real agent
#                     harness before they're production-ready
#
# DRAFT_SESSION_INTELLIGENCE — session transcript synthesis (Phase 1)
# DRAFT_GRANOLA_INTELLIGENCE — Granola meeting synthesis    (Phase 2)
# DRAFT_SLACK_INTELLIGENCE   — Slack message batch synthesis (Phase 3)

DRAFT_SESSION_INTELLIGENCE="${DRAFT_SESSION_INTELLIGENCE:-claude-code}"
DRAFT_GRANOLA_INTELLIGENCE="${DRAFT_GRANOLA_INTELLIGENCE:-claude-code}"
DRAFT_SLACK_INTELLIGENCE="${DRAFT_SLACK_INTELLIGENCE:-claude-code}"

# ── Granola integration mode ───────────────────────────────────────────────────
# Controls how the Granola synthesizer fetches meeting transcripts.
#
# "mcp" (default) — Claude Code uses its connected Granola MCP tools to fetch
#                   and synthesize in a single agent call. No REST token needed.
#                   Requires: Granola MCP added to ~/.claude/settings.json
#                   Set up via: /draft:connect granola (Claude Code slash command)
#
# "api"           — Daemon fetches transcripts directly via Granola REST API.
#                   Synthesis is then passed as text to the intelligence adapter.
#                   Requires: granola_api_token in config/secrets.json
#                   Set up via: /draft:connect granola (choose API option)
#
# The "mcp" path is recommended when claude-code is the intelligence adapter —
# Claude fetches and synthesizes in one step, no bash REST plumbing needed.
# The "api" path is available for future stateless adapters that receive
# transcript text as input rather than calling MCP tools themselves.

DRAFT_GRANOLA_MODE="${DRAFT_GRANOLA_MODE:-mcp}"

# If granola_mode is saved in secrets.json (written by /draft:connect), use it.
# This lets the skill persist the user's MCP vs API choice across daemon restarts.
# Precedence: env var override > secrets.json > default ("mcp")
if [ -z "${DRAFT_GRANOLA_MODE_OVERRIDE+x}" ] && [ -f "$DRAFT_SECRETS" ]; then
    _secrets_granola_mode=$(python3 -c "
import json, sys
try:
    d = json.load(open('$DRAFT_SECRETS'))
    v = d.get('granola_mode', '')
    if v in ('mcp', 'api'): print(v)
except: pass
" 2>/dev/null || echo "")
    if [ -n "$_secrets_granola_mode" ]; then
        DRAFT_GRANOLA_MODE="$_secrets_granola_mode"
    fi
fi

# ── Slack integration config ───────────────────────────────────────────────────
# DRAFT_SLACK_MODE          — "passive" (capture all) or "tagged" (!draft only)
# DRAFT_SLACK_ANALYSIS_WINDOW — how many hours back to synthesize per run
# DRAFT_SLACK_CAPTURE_PID  — PID file for the long-running capture process

DRAFT_SLACK_MODE="${DRAFT_SLACK_MODE:-passive}"
DRAFT_SLACK_ANALYSIS_WINDOW="${DRAFT_SLACK_ANALYSIS_WINDOW:-8}"
DRAFT_SLACK_CAPTURE_PID="$DRAFT_BACKGROUND/integrations/slack/capture.pid"

# If slack_capture_mode is saved in secrets.json (written by /draft:connect slack),
# use it. Precedence: env var override > secrets.json > default ("passive")
if [ -z "${DRAFT_SLACK_MODE_OVERRIDE+x}" ] && [ -f "$DRAFT_SECRETS" ]; then
    _secrets_slack_mode=$(python3 -c "
import json, sys
try:
    d = json.load(open('$DRAFT_SECRETS'))
    v = d.get('slack_capture_mode', '')
    if v in ('passive', 'tagged'): print(v)
except: pass
" 2>/dev/null || echo "")
    if [ -n "$_secrets_slack_mode" ]; then
        DRAFT_SLACK_MODE="$_secrets_slack_mode"
    fi
fi

# ── Exports ────────────────────────────────────────────────────────────────────
export DRAFT_GLOBAL DRAFT_ACTIVE_PROFILE DRAFT_WORKSPACE
export DRAFT_BACKGROUND DRAFT_PENDING DRAFT_FAILED DRAFT_LOGS DRAFT_STAGING
export DRAFT_CONFIG DRAFT_SECRETS DRAFT_LOCAL
export DRAFT_PENDING_POLL DRAFT_GRANOLA_POLL DRAFT_SLACK_CAPTURE DRAFT_SLACK_ANALYSIS
export DRAFT_SLACK_MODE DRAFT_SLACK_ANALYSIS_WINDOW DRAFT_SLACK_CAPTURE_PID
export DRAFT_SESSION_INTELLIGENCE DRAFT_GRANOLA_INTELLIGENCE DRAFT_SLACK_INTELLIGENCE
export DRAFT_GRANOLA_MODE

# ── GitHub integration ──────────────────────────────────────────────────────────
DRAFT_GITHUB_POLL="${DRAFT_GITHUB_POLL:-3600}"       # 1 hour default
DRAFT_GITHUB_INTELLIGENCE="${DRAFT_GITHUB_INTELLIGENCE:-claude-code}"
export DRAFT_GITHUB_POLL DRAFT_GITHUB_INTELLIGENCE
