#!/usr/bin/env bash
# Runs the draft CLI from this checkout against the local backend and the staging project.
#   scripts/draft-local.sh auth login
#   scripts/draft-local.sh people find --me
# It keeps its own login in ~/.draft-staging-home, so your installed draft CLI and its login are left alone.
# Start the backend first: make run-local
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ENV_FILE="$ROOT_DIR/.env.staging"
[ -f "$ENV_FILE" ] || { echo "draft-local: $ENV_FILE not found" >&2; exit 1; }

env_value() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d "\"'"; }

DRAFT_SUPABASE_URL=$(env_value SUPABASE_URL)
DRAFT_SUPABASE_PUBLISHABLE_KEY=$(env_value SUPABASE_PUBLISHABLE_KEY)
[ -n "$DRAFT_SUPABASE_URL" ] && [ -n "$DRAFT_SUPABASE_PUBLISHABLE_KEY" ] || { echo "draft-local: .env.staging has no SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY" >&2; exit 1; }
export DRAFT_SUPABASE_URL DRAFT_SUPABASE_PUBLISHABLE_KEY
export DRAFT_API_BASE_URL="http://localhost:$(env_value DRAFT_BACKEND_PORT | grep . || echo 8787)"
export DRAFT_APP_URL="http://localhost:$(env_value DRAFT_WEB_PORT | grep . || echo 3000)"

export HOME="${DRAFT_LOCAL_HOME:-$HOME/.draft-staging-home}"
mkdir -p "$HOME"
exec bun run "$ROOT_DIR/apps/cli/src/index.ts" "$@"
