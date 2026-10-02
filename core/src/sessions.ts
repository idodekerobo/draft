// core/src/sessions.ts — shared session-capture hook template and
// SessionEnd merge/remove logic for the CLI and desktop app, so the two
// installers can't drift.

import type { ClaudeSettings } from "./sync/claude-settings";

export const DRAFT_DIR = ".claude/draft";
export const CAPTURE_CONFIG_FILE = "config.json";
export const HOOK_SCRIPT_FILE = "capture-session.sh";
export const HOOK_COMMAND = `"\${CLAUDE_PROJECT_DIR}/${DRAFT_DIR}/${HOOK_SCRIPT_FILE}"`;

// Bump when buildCaptureScript changes, so `sessions status` can flag stale copies.
export const CAPTURE_SCRIPT_VERSION = 2;

// Must exceed the curl caps in the script (20s upload + 5s error report).
export const HOOK_TIMEOUT_SECONDS = 30;

// Prefers the draft CLI when installed; otherwise posts the transcript with
// curl so capture works on machines that never installed it. Every network
// call has a hard cap and the script always exits 0. It avoids the dollar-brace
// expansion form so the template needs no escaping.
export function buildCaptureScript(): string {
  return String.raw`#!/usr/bin/env bash
# draft-capture-script-version: ${CAPTURE_SCRIPT_VERSION}
# Installed by draft sessions enable -- do not edit by hand, re-run enable instead.
# Claude Code SessionEnd hook. Uses the draft CLI when it is installed, else posts
# the transcript with curl. Network calls are time-capped. Always exits 0.
SCRIPT_VERSION=${CAPTURE_SCRIPT_VERSION}
LOG_DIR="$HOME/.draft/log"
LOG="$LOG_DIR/sessions-ingest.log"
DEFAULT_BACKEND="https://api.draftai.us"

resolve_draft() {
  if [ -x "$HOME/.draft/bin/draft" ]; then echo "$HOME/.draft/bin/draft"; return; fi
  if [ -x "/usr/local/bin/draft" ]; then echo "/usr/local/bin/draft"; return; fi
  if [ -n "$DRAFT_BIN" ] && [ -x "$DRAFT_BIN" ]; then echo "$DRAFT_BIN"; return; fi
  echo ""
}
DRAFT="$(resolve_draft)"
if [ -n "$DRAFT" ]; then
  "$DRAFT" sessions ingest >/dev/null 2>&1
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG="$SCRIPT_DIR/config.json"
INPUT="$(cat)"
SESSION_ID=""

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\000-\037'; }
urlenc() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n' | sed 's/../%&/g'; }
unescape() { sed -e 's/\\\\/\\/g' -e 's#\\/#/#g'; }
json_field() {
  printf '%s' "$INPUT" | tr -d '\n\r' | sed -nE 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | head -n 1
}
config_value() {
  sed -nE 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$CONFIG" 2>/dev/null | head -n 1
}
is_placeholder() { case "$1" in *'$''{'*) return 0 ;; esac; return 1; }

log_event() {
  mkdir -p "$LOG_DIR" 2>/dev/null
  printf '{"ts":"%s","status":"%s","dir":"%s","sessionId":"%s","detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$(json_escape "$PROJECT_DIR")" "$(json_escape "$SESSION_ID")" "$(json_escape "$2")" >> "$LOG" 2>/dev/null
}

post_json() {
  url="$1"; body="$2"; shift 2
  curl -sS -o /dev/null --connect-timeout 3 --max-time 5 -X POST -H 'Content-Type: application/json' "$@" --data "$body" "$url" >/dev/null 2>&1
}

report_error() {
  code="$1"; reason="$2"
  base="$BACKEND"
  case "$base" in http://*|https://*) ;; *) base="$DEFAULT_BACKEND" ;; esac
  is_placeholder "$base" && base="$DEFAULT_BACKEND"
  body="$(printf '{"code":"%s","reason":"%s","scriptVersion":"%s","os":"%s","hookReason":"%s","workspaceId":"%s"}' \
    "$code" "$(json_escape "$reason" | cut -c1-200)" "$SCRIPT_VERSION" "$(uname -s 2>/dev/null)" "$(json_escape "$REASON")" "$(json_escape "$WORKSPACE_ID")")"
  if [ -n "$TOKEN_OK" ]; then
    post_json "$base/sessions/ingest-errors" "$body" -H "Authorization: Bearer $TOKEN"
  else
    post_json "$base/sessions/ingest-errors" "$body"
  fi
}

SESSION_ID="$(json_field session_id)"
TRANSCRIPT="$(json_field transcript_path | unescape)"
CWD="$(json_field cwd | unescape)"
REASON="$(json_field reason)"
BACKEND="$(config_value backendUrl | sed 's#/*$##')"
TOKEN="$(config_value ingestToken)"
WORKSPACE_ID="$(config_value workspaceId)"
TOKEN_OK=""

if [ ! -f "$CONFIG" ]; then
  log_event skipped missing-config; report_error missing-config "no config.json next to the hook"; exit 0
fi
for value in "$BACKEND" "$TOKEN" "$WORKSPACE_ID" "$(config_value projectId)" "$(config_value projectKey)"; do
  if [ -z "$value" ] || is_placeholder "$value"; then
    log_event skipped placeholder-config; report_error placeholder-config "config.json holds an empty or placeholder value"; exit 0
  fi
done
case "$TOKEN" in draft_sit_*) TOKEN_OK=1 ;; esac
case "$BACKEND" in http://*|https://*) ;; *) log_event skipped placeholder-config; report_error placeholder-config "backendUrl is not an http(s) url"; exit 0 ;; esac
if [ -z "$TOKEN_OK" ]; then
  log_event skipped missing-token; report_error missing-token "ingestToken does not look like an ingest token"; exit 0
fi

if [ -z "$SESSION_ID" ] || [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  log_event skipped missing-transcript; report_error missing-transcript "hook input had no readable transcript"; exit 0
fi

GIT_DIR_ARG="$CWD"
[ -z "$GIT_DIR_ARG" ] && GIT_DIR_ARG="."
GIT_EMAIL="$(git -C "$GIT_DIR_ARG" config --get user.email 2>/dev/null)"
if [ -z "$GIT_EMAIL" ]; then
  log_event skipped missing-git-email; report_error missing-git-email "git user.email is not set"; exit 0
fi
DISPLAY_NAME="$(git -C "$GIT_DIR_ARG" config --get user.name 2>/dev/null)"

URL="$BACKEND/sessions/ingest?sessionId=$(urlenc "$SESSION_ID")&gitEmail=$(urlenc "$GIT_EMAIL")&displayName=$(urlenc "$DISPLAY_NAME")&cwd=$(urlenc "$CWD")&status=$(urlenc "$REASON")&source=claude-code-session"
RESPONSE="$(curl -sS --connect-timeout 5 --max-time 20 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/octet-stream' --data-binary @"$TRANSCRIPT" -w '\n%{http_code}' "$URL" 2>/dev/null)"
RC=$?
HTTP="$(printf '%s' "$RESPONSE" | tail -n 1)"
RESPONSE_BODY="$(printf '%s' "$RESPONSE" | sed '$d')"

if [ "$RC" -ne 0 ]; then
  if [ "$RC" -eq 28 ]; then CODE=upload-timeout; else CODE=upload-failed; fi
  log_event failure "$CODE curl-exit=$RC"; report_error "$CODE" "curl exit $RC"
elif [ "$HTTP" -ge 200 ] 2>/dev/null && [ "$HTTP" -lt 300 ]; then
  log_event success ""
elif [ "$HTTP" = "403" ] && printf '%s' "$RESPONSE_BODY" | grep -q session_tracking_disabled; then
  log_event skipped session_tracking_disabled
else
  log_event failure "status=$HTTP"; report_error "http-$HTTP" "$RESPONSE_BODY"
fi
exit 0
`;
}

export function hasSessionEndHook(settings: ClaudeSettings): boolean {
  return (settings.hooks?.SessionEnd ?? []).some((entry) => entry.hooks.some((h) => h.command === HOOK_COMMAND));
}

type SessionEndHookEntry = NonNullable<NonNullable<ClaudeSettings["hooks"]>["SessionEnd"]>[number]["hooks"][number];

function isCurrentHook(h: SessionEndHookEntry): boolean {
  return h.command === HOOK_COMMAND && h.timeout === HOOK_TIMEOUT_SECONDS && h.async === true;
}

// Returns the same object when nothing changes: callers use reference
// equality as the no-op signal.
export function mergeSessionEndHook(settings: ClaudeSettings): ClaudeSettings {
  const entries = settings.hooks?.SessionEnd ?? [];
  if (!hasSessionEndHook(settings)) {
    return {
      ...settings,
      hooks: {
        ...settings.hooks,
        SessionEnd: [
          ...entries,
          { hooks: [{ type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT_SECONDS, async: true }] },
        ],
      },
    };
  }
  const stale = entries.some((entry) => entry.hooks.some((h) => h.command === HOOK_COMMAND && !isCurrentHook(h)));
  if (!stale) return settings;
  return {
    ...settings,
    hooks: {
      ...settings.hooks,
      SessionEnd: entries.map((entry) => ({
        ...entry,
        hooks: entry.hooks.map((h) => (h.command === HOOK_COMMAND ? { ...h, timeout: HOOK_TIMEOUT_SECONDS, async: true } : h)),
      })),
    },
  };
}

export function removeSessionEndHook(settings: ClaudeSettings): ClaudeSettings {
  if (!hasSessionEndHook(settings)) return settings;
  const filtered = (settings.hooks?.SessionEnd ?? [])
    .map((entry) => ({ ...entry, hooks: entry.hooks.filter((h) => h.command !== HOOK_COMMAND) }))
    .filter((entry) => entry.hooks.length > 0);
  const nextHooks = { ...settings.hooks };
  if (filtered.length === 0) delete nextHooks.SessionEnd;
  else nextHooks.SessionEnd = filtered;
  return { ...settings, hooks: nextHooks };
}

// Checks the same three locations the hook script itself checks, so
// `sessions status` can report which one (if any) resolved.
export function resolveDraftBinaryPath(env: NodeJS.ProcessEnv, isExecutable: (path: string) => boolean): string | null {
  const home = env.HOME;
  if (home) {
    const homeBin = `${home}/.draft/bin/draft`;
    if (isExecutable(homeBin)) return homeBin;
  }
  if (isExecutable("/usr/local/bin/draft")) return "/usr/local/bin/draft";
  if (env.DRAFT_BIN && isExecutable(env.DRAFT_BIN)) return env.DRAFT_BIN;
  return null;
}
