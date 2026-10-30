#!/bin/sh
# Minimal privileged bootstrap; lifecycle logic lives in runner.ts.
set -eu

[ "$(id -u)" -eq 0 ] || {
  echo "[entrypoint] fatal: bootstrap must run as root" >&2
  exit 1
}

: "${DRAFT_CALLBACK_URL:?DRAFT_CALLBACK_URL is required}"

callback_host="$({ node -e '
  const url = new URL(process.env.DRAFT_CALLBACK_URL);
  if (url.protocol !== "https:" || (url.port && url.port !== "443")) {
    throw new Error("callback must use HTTPS on port 443");
  }
  if (url.username || url.password) throw new Error("callback URL must not contain credentials");
  process.stdout.write(url.hostname);
'; } 2>/dev/null)" || {
  echo "[entrypoint] fatal: invalid callback URL" >&2
  exit 1
}

# A run reaches only its own model provider, the callback and the bundle storage.
if [ "${DRAFT_RUN_HARNESS:-claude}" = "codex" ]; then
  model_hosts="chatgpt.com auth.openai.com api.openai.com"
  export DRAFT_EGRESS_REQUIRED_HOST="chatgpt.com"
else
  model_hosts="api.anthropic.com"
  export DRAFT_EGRESS_REQUIRED_HOST="api.anthropic.com"
fi
export DRAFT_EGRESS_HOSTS="${model_hosts} ${callback_host} ${DRAFT_EGRESS_HOSTS:-}"
export DRAFT_CALLBACK_HOST="$callback_host"
/usr/local/sbin/configure-egress.sh

exec node /opt/draft/runner.mjs
