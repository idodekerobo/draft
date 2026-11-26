#!/bin/sh
# Minimal privileged bootstrap; lifecycle logic lives in runner.ts (routine) or host.ts (cloud session).
set -eu

[ "$(id -u)" -eq 0 ] || {
  echo "[entrypoint] fatal: bootstrap must run as root" >&2
  exit 1
}

# Cloud-session host: a long-lived process that keeps HOME, the workspace and the
# harness login on the /data volume. Unset or "routine" runs the routine path below.
case "${DRAFT_MODE:-routine}" in
  host)
    : "${DRAFT_API_BASE_URL:?DRAFT_API_BASE_URL is required}"
    : "${DRAFT_SEED:?DRAFT_SEED is required}"
    network="${DRAFT_NETWORK:-restricted}"
    case "$network" in
      restricted | open) ;;
      *)
        echo "[entrypoint] fatal: DRAFT_NETWORK must be restricted or open" >&2
        exit 1
        ;;
    esac

    agent_uid="$(id -u agent)"
    agent_gid="$(id -g agent)"
    mkdir -p /data/.draft/bin
    chown "$agent_uid:$agent_gid" /data /data/.draft /data/.draft/bin
    # The core driver starts tmux from $HOME/.draft/bin/tmux, so point that path at the system binary.
    ln -sfn /usr/bin/tmux /data/.draft/bin/tmux

    api_host="$({ node -e '
      const url = new URL(process.env.DRAFT_API_BASE_URL);
      if (url.protocol !== "https:" || (url.port && url.port !== "443")) throw new Error("api");
      if (url.username || url.password) throw new Error("api");
      process.stdout.write(url.hostname);
    '; } 2>/dev/null)" || {
      echo "[entrypoint] fatal: DRAFT_API_BASE_URL must be an https URL on port 443" >&2
      exit 1
    }
    # Node errors are dropped: they can echo DRAFT_SEED, which may hold a credential.
    seed_host="$({ node -e '
      const seed = JSON.parse(process.env.DRAFT_SEED);
      if (seed.kind === "snapshot") process.stdout.write(new URL(seed.url).hostname);
      else if (seed.kind === "routine_run") process.stdout.write("");
      else if (seed.kind === "repo") {
        try {
          process.stdout.write(new URL(seed.gitRemote).hostname);
        } catch {
          process.stdout.write(/^[^@\s]+@([^:\s]+):/.exec(seed.gitRemote)[1]);
        }
      } else throw new Error("seed");
    '; } 2>/dev/null)" || {
      echo "[entrypoint] fatal: DRAFT_SEED must name a host" >&2
      exit 1
    }

    # The harness is chosen per session after boot, so both model providers are allowed.
    export DRAFT_EGRESS_REQUIRED_HOST="api.anthropic.com"
    if [ "$network" = "restricted" ]; then
      export DRAFT_EGRESS_HOSTS="api.anthropic.com chatgpt.com auth.openai.com api.openai.com ${api_host} ${seed_host} ${DRAFT_EGRESS_HOSTS:-}"
      # configure-egress.sh requires the host the session reports to. For a cloud session that is the API.
      export DRAFT_CALLBACK_HOST="$api_host"
      /usr/local/sbin/configure-egress.sh
    else
      /usr/local/sbin/configure-open-egress.sh
    fi

    # The image pins Claude Code, so its self-updater stays off.
    exec gosu agent env HOME=/data DISABLE_AUTOUPDATER=1 /usr/local/bin/bun /opt/draft/host.mjs
    ;;
  computer)
    # Home's computer: a server on the /data volume that runs commands and edits files for the backend. Its token comes in the
    # environment and never leaves it. Network is open: the person's work often needs the internet.
    : "${DRAFT_COMPUTER_TOKEN:?DRAFT_COMPUTER_TOKEN is required}"
    agent_uid="$(id -u agent)"
    agent_gid="$(id -g agent)"
    mkdir -p /data/workspace /data/.draft/computer
    # The server and the commands it runs are the same user, so they share the volume. Job records live beside the workspace, in
    # their own directory; this is the person's own sandbox, so a command that edits them harms only its own job's report.
    chown "$agent_uid:$agent_gid" /data /data/workspace /data/.draft /data/.draft/computer
    /usr/local/sbin/configure-open-egress.sh
    exec gosu agent env HOME=/data DRAFT_COMPUTER_ROOT=/data/workspace DRAFT_COMPUTER_STATE=/data/.draft/computer /usr/local/bin/bun /opt/draft/computer.mjs
    ;;
  routine) ;;
  *)
    echo "[entrypoint] fatal: DRAFT_MODE must be host, computer or routine" >&2
    exit 1
    ;;
esac

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

# The harness comes from the run manifest. The runner refuses a run without one.
harness="$({ node -e '
  const harness = JSON.parse(process.env.DRAFT_RUN_MANIFEST).harness;
  process.stdout.write(harness === "codex" ? "codex" : "claude");
'; } 2>/dev/null)" || harness="claude"

network="$({ node -e '
  const value = JSON.parse(process.env.DRAFT_RUN_MANIFEST).network ?? "restricted";
  if (value !== "open" && value !== "restricted") throw new Error("invalid network mode");
  process.stdout.write(value);
'; } 2>/dev/null)" || {
  echo "[entrypoint] fatal: invalid network mode" >&2
  exit 1
}

# A run reaches only its own model provider, the callback and the bundle storage.
if [ "$harness" = "codex" ]; then
  model_hosts="chatgpt.com auth.openai.com api.openai.com"
  export DRAFT_EGRESS_REQUIRED_HOST="chatgpt.com"
else
  model_hosts="api.anthropic.com"
  export DRAFT_EGRESS_REQUIRED_HOST="api.anthropic.com"
fi
if [ "$network" = "restricted" ]; then
  export DRAFT_EGRESS_HOSTS="${model_hosts} ${callback_host} ${DRAFT_EGRESS_HOSTS:-}"
  export DRAFT_CALLBACK_HOST="$callback_host"
  /usr/local/sbin/configure-egress.sh
fi

exec node /opt/draft/runner.mjs
