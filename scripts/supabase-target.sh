#!/usr/bin/env bash
# Usage: scripts/supabase-target.sh <staging|prod|status>
# Points the Supabase CLI's --linked target at the env's project, using the
# project ref and DB password from .env.staging / .env.production.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

env_value() { grep "^$2=" "$1" | head -1 | cut -d= -f2- | tr -d "\"'"; }
ref_of() { env_value "$1" SUPABASE_URL | sed -E 's#https://([^.]+)\..*#\1#'; }

STAGING_REF=$(ref_of .env.staging)
PROD_REF=$(ref_of .env.production)
LINKED_REF=$(cat supabase/.temp/project-ref 2>/dev/null || true)

label() {
  case "$1" in
    "$STAGING_REF") echo staging ;;
    "$PROD_REF") echo PROD ;;
    *) echo unknown ;;
  esac
}

case "${1:-status}" in
  status) ;;
  staging|prod)
    if [ "$1" = staging ]; then file=.env.staging; ref=$STAGING_REF; else file=.env.production; ref=$PROD_REF; fi
    [ -n "$ref" ] || { echo "no SUPABASE_URL in $file" >&2; exit 1; }
    [ "$STAGING_REF" != "$PROD_REF" ] || { echo "staging and prod refs are identical; fix .env.staging" >&2; exit 1; }
    supabase link --project-ref "$ref" --password "$(env_value "$file" SUPABASE_DB_PASSWORD)" >/dev/null
    LINKED_REF=$ref
    ;;
  *) echo "usage: $0 <staging|prod|status>" >&2; exit 1 ;;
esac

echo "Supabase CLI linked to: $(label "$LINKED_REF") ($LINKED_REF)"
