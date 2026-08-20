#!/usr/bin/env bash
set -u

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ROOT_ENV="$ROOT_DIR/.env.local"
PIDS=""
NAMES=""
SHUTTING_DOWN=0

fail() { printf 'run-local: %s\n' "$1" >&2; exit 1; }

# Parse dotenv assignments without sourcing arbitrary shell code. This matters
# for values such as FLY_API_TOKEN, which may contain spaces or punctuation.
# Non-empty values loaded later override earlier values; blank root placeholders
# therefore leave the preserved module env values available during migration.
load_dotenv() {
  env_file=$1
  [ -f "$env_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line=${line#"${line%%[![:space:]]*}"}
    case "$line" in
      ''|'#'*) continue ;;
    esac

    case "$line" in
      export[[:space:]]*) line=${line#export}; line=${line#"${line%%[![:space:]]*}"} ;;
    esac

    case "$line" in
      *=*) ;;
      *) continue ;;
    esac

    key=${line%%=*}
    value=${line#*=}
    key=${key%"${key##*[![:space:]]}"}
    value=${value#"${value%%[![:space:]]*}"}
    value=${value%"${value##*[![:space:]]}"}

    case "$key" in
      ''|*[!A-Za-z0-9_]*|[0-9]*) continue ;;
    esac

    case "$value" in
      \"*\") value=${value#\"}; value=${value%\"} ;;
      \'*\') value=${value#\'}; value=${value%\'} ;;
    esac

    [ -n "$value" ] || continue
    printf -v "$key" '%s' "$value"
  done < "$env_file"
}

require_env_var() {
  var_name=$1
  var_value=${!var_name:-}
  [ -n "$var_value" ] || fail ".env.local and preserved app env files are missing $var_name. Add it without committing secrets."
}

require_url() {
  var_name=$1
  var_value=${!var_name:-}
  case "$var_value" in
    http://*|https://*) ;;
    *) fail "$var_name must be an http:// or https:// URL (got '$var_value')." ;;
  esac
}

require_https_url() {
  var_name=$1
  var_value=${!var_name:-}
  case "$var_value" in
    https://*) ;;
    *) fail "$var_name must be an https:// URL for backend callbacks (got '$var_value')." ;;
  esac
}

require_port() {
  var_name=$1
  var_value=${!var_name:-}
  case "$var_value" in
    ''|*[!0-9]*) fail "$var_name must be a numeric port (got '$var_value')." ;;
  esac
}

port_is_open() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

cleanup() {
  [ "$SHUTTING_DOWN" -eq 1 ] && return
  SHUTTING_DOWN=1
  trap - EXIT INT TERM HUP
  [ -n "$PIDS" ] || return
  printf '\nStopping local Draft services…\n'
  for pid in $PIDS; do kill -TERM "$pid" 2>/dev/null || true; done
  attempts=0
  while [ "$attempts" -lt 30 ]; do
    alive=""
    for pid in $PIDS; do kill -0 "$pid" 2>/dev/null && alive="$alive $pid"; done
    [ -z "$alive" ] && break
    sleep 0.1
    attempts=$((attempts + 1))
  done
  for pid in $PIDS; do kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true; done
  for pid in $PIDS; do wait "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT INT TERM HUP

command -v bun >/dev/null 2>&1 || fail "bun is required. Install it, then retry."
command -v lsof >/dev/null 2>&1 || fail "lsof is required for port preflight checks."
[ -f "$ROOT_ENV" ] || fail ".env.local is required. Copy .env.example to .env.local and fill in the required values."

# Preserve the existing app-local files during migration. The root file is
# loaded last, so any non-empty root value becomes the canonical override.
load_dotenv "$ROOT_DIR/backend/.env.local"
load_dotenv "$ROOT_DIR/web-app/.env.local"
load_dotenv "$ROOT_DIR/landing-page-app/.env.local"
load_dotenv "$ROOT_ENV"

# These are the canonical local-stack names. The root file is authoritative;
# app-specific NEXT_PUBLIC_* aliases are created only for the services that
# actually consume them.
DRAFT_APP_URL=${DRAFT_APP_URL:-}
DRAFT_API_BASE_URL=${DRAFT_API_BASE_URL:-}
DRAFT_LANDING_PORT=${DRAFT_LANDING_PORT:-3001}
DRAFT_WEB_PORT=${DRAFT_WEB_PORT:-3000}
DRAFT_BACKEND_PORT=${DRAFT_BACKEND_PORT:-8787}
DRAFT_LANDING_URL=${DRAFT_LANDING_URL:-http://localhost:$DRAFT_LANDING_PORT}

require_env_var DRAFT_APP_URL
require_env_var DRAFT_API_BASE_URL
require_url DRAFT_APP_URL
require_https_url DRAFT_API_BASE_URL
require_port DRAFT_WEB_PORT
require_port DRAFT_LANDING_PORT
require_port DRAFT_BACKEND_PORT

for dir in web-app landing-page-app backend desktop; do
  [ -d "$ROOT_DIR/$dir" ] || fail "missing required directory: $dir"
  [ -d "$ROOT_DIR/$dir/node_modules" ] || fail "$dir dependencies are missing. Install them before running make run-local."
done

for key in SUPABASE_URL SUPABASE_PUBLISHABLE_KEY SUPABASE_SECRET_KEY FLY_API_TOKEN FLY_APP_NAME FLY_SANDBOX_IMAGE FLY_REGION SANDBOX_CALLBACK_SECRET GITHUB_APP_ID GITHUB_APP_SLUG GITHUB_APP_PRIVATE_KEY GITHUB_APP_WEBHOOK_SECRET; do
  require_env_var "$key"
done

# Backend CORS uses APP_URL as an exact browser-origin match. It is derived
# from the same canonical value used by the web app and desktop pairing flow.
APP_URL="$DRAFT_APP_URL"
API_BASE_URL="$DRAFT_API_BASE_URL"

for port in "$DRAFT_WEB_PORT" "$DRAFT_LANDING_PORT" "$DRAFT_BACKEND_PORT"; do
  port_is_open "$port" && fail "port $port is already in use. Stop that process and retry."
done

web_env=(
  "PORT=$DRAFT_WEB_PORT"
  "NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL"
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$SUPABASE_PUBLISHABLE_KEY"
  "NEXT_PUBLIC_API_BASE_URL=$DRAFT_API_BASE_URL"
  "NEXT_PUBLIC_DOWNLOAD_URL=${NEXT_PUBLIC_DOWNLOAD_URL:-https://github.com/idodekerobo/draft/releases/latest/download/stable-macos-arm64-Draft.dmg}"
)

landing_env=(
  "PORT=$DRAFT_LANDING_PORT"
  "NEXT_PUBLIC_APP_URL=$DRAFT_APP_URL"
  "NEXT_PUBLIC_CRISP_WEBSITE_ID=${NEXT_PUBLIC_CRISP_WEBSITE_ID:-}"
  "NEXT_PUBLIC_POSTHOG_HOST=${NEXT_PUBLIC_POSTHOG_HOST:-https://us.i.posthog.com}"
  "CRISP_HISTORY_SECRET=${CRISP_HISTORY_SECRET:-}"
  "CRISP_API_IDENTIFIER=${CRISP_API_IDENTIFIER:-}"
  "CRISP_API_KEY=${CRISP_API_KEY:-}"
)

backend_env=(
  "PORT=$DRAFT_BACKEND_PORT"
  "APP_URL=$DRAFT_APP_URL"
  "API_BASE_URL=$DRAFT_API_BASE_URL"
  "DRAFT_API_BASE_URL=$DRAFT_API_BASE_URL"
  "SUPABASE_URL=$SUPABASE_URL"
  "SUPABASE_PUBLISHABLE_KEY=$SUPABASE_PUBLISHABLE_KEY"
  "SUPABASE_SECRET_KEY=$SUPABASE_SECRET_KEY"
  "FLY_API_TOKEN=$FLY_API_TOKEN"
  "FLY_APP_NAME=$FLY_APP_NAME"
  "FLY_SANDBOX_IMAGE=$FLY_SANDBOX_IMAGE"
  "FLY_REGION=$FLY_REGION"
  "SUPABASE_DB_PASSWORD=${SUPABASE_DB_PASSWORD:-}"
  "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_CODE_OAUTH_TOKEN:-}"
  "SANDBOX_CALLBACK_SECRET=${SANDBOX_CALLBACK_SECRET:-}"
  "SPIKE2_CALLBACK_PORT=${SPIKE2_CALLBACK_PORT:-}"
  "INFERENCE_CREDENTIAL_KEK_V1=${INFERENCE_CREDENTIAL_KEK_V1:-}"
  "SLACK_BATCH_MAX_CONTENT_BYTES=${SLACK_BATCH_MAX_CONTENT_BYTES:-}"
  "SLACK_BATCH_MAX_MESSAGES=${SLACK_BATCH_MAX_MESSAGES:-}"
  "SLACK_BATCH_MAX_SPAN_HOURS=${SLACK_BATCH_MAX_SPAN_HOURS:-}"
  "GITHUB_APP_ID=$GITHUB_APP_ID"
  "GITHUB_APP_SLUG=$GITHUB_APP_SLUG"
  "GITHUB_APP_PRIVATE_KEY=$GITHUB_APP_PRIVATE_KEY"
  "GITHUB_APP_PRIVATE_KEY_PREVIOUS=${GITHUB_APP_PRIVATE_KEY_PREVIOUS:-}"
  "GITHUB_APP_WEBHOOK_SECRET=$GITHUB_APP_WEBHOOK_SECRET"
)

desktop_env=(
  "DRAFT_API_BASE_URL=$DRAFT_API_BASE_URL"
  "DRAFT_APP_URL=$DRAFT_APP_URL"
  "DRAFT_SUPABASE_URL=$SUPABASE_URL"
  "DRAFT_SUPABASE_PUBLISHABLE_KEY=$SUPABASE_PUBLISHABLE_KEY"
)

start_service() {
  name=$1
  dir=$2
  shift 2
  (cd "$ROOT_DIR/$dir" && exec "$@") &
  pid=$!
  PIDS="$PIDS $pid"
  NAMES="$NAMES $name:$pid"
  printf 'Started %-8s pid %s\n' "$name" "$pid"
}

# The explicit --port flags are intentional. Next.js reads PORT from the
# process environment during CLI parsing, before it loads app-local dotenv.
start_service web web-app env "${web_env[@]}" bun run dev -- --port "$DRAFT_WEB_PORT"
start_service landing landing-page-app env "${landing_env[@]}" bun run dev -- --port "$DRAFT_LANDING_PORT"
start_service backend backend env "${backend_env[@]}" bun run dev
start_service desktop desktop env "${desktop_env[@]}" bun run dev

printf 'Draft local stack is running. Press Ctrl-C to stop all services.\n'
printf '  web:     %s\n' "$DRAFT_APP_URL"
printf '  landing: %s\n' "$DRAFT_LANDING_URL"
printf '  backend: %s\n' "$DRAFT_API_BASE_URL"

while :; do
  for entry in $NAMES; do
    name=${entry%%:*}
    pid=${entry##*:}
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" 2>/dev/null
      status=$?
      printf 'run-local: %s exited unexpectedly (status %s); stopping all services.\n' "$name" "$status" >&2
      exit "$status"
    fi
  done
  sleep 1
done
