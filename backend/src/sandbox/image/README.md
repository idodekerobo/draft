# Sandbox image

One image runs two modes on Fly Machines. Both start as root, set the network
policy, and then run as the unprivileged `agent` user.

- **Routine runner** (`DRAFT_MODE` unset or `routine`). A one-shot job. The
  runner starts the harness (Claude Code or Codex) and reports the result to the
  backend.
- **Cloud-session host** (`DRAFT_MODE=host`). A long-running process. The host
  keeps a session alive, drives the harness in tmux, and sleeps the session when
  it is idle.

## What is in the image

- `runner.mjs`: the routine runner, bundled from `backend/src/sandbox/runner.ts`.
  It is not in git. `bun run build:runner` (from `backend`) writes it into this
  folder. The Dockerfile only copies it.
- `host.mjs`: the cloud-session host, bundled from `backend/src/sandbox/host.ts`
  and `backend/src/sandbox/host/*`, with the `core/src/host` modules it imports.
  It is not in git. `bun run build:host` (from `backend`) writes it here.
- `entrypoint.sh`: the root bootstrap for both modes.
- `configure-egress.sh`: the restricted policy (an allowlist).
- `configure-open-egress.sh`: the open policy (private ranges blocked).
- Bun, pinned by `BUN_VERSION` and checked against `BUN_SHA256`. It runs the
  host.
- tmux, the system binary the host uses to run Claude.
- The pinned `claude` and `codex` CLIs.

The routine bundle holds only runner-side code: `sandbox/runner.ts`,
`sandbox/runner/*`, `core/src/harnesses/*/runner.ts`,
`core/src/harnesses/failure.ts`, `core/src/run-manifest.ts` and
`core/src/run-spec.ts`. It imports only Node built-ins.
`backend/src/__tests__/sandbox/runner-bundle.test.ts` fails if anything else gets
in. The host bundle has its own rules, in `host-bundle.test.ts`.

A backend deploy does not rebuild this image. Rebuild and roll out the image
(the `fly-sandbox-image` skill) after changing any file above.

## Routine runtime environment

Set by the backend in `backend/src/metaharness/sandbox/launch.ts`:

- `DRAFT_RUN_ID`, `DRAFT_BUNDLE_HASH`, `DRAFT_BUNDLE_URL`
- `DRAFT_CALLBACK_URL`, `DRAFT_CALLBACK_TOKEN`
- `DRAFT_RUN_MANIFEST`: what to run (harness, model, tools, output, timeout)
- The harness login: `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_AUTH_JSON`
- `DRAFT_RUN_TOKEN` when the run has Draft tools
- `DRAFT_EGRESS_HOSTS` for extra HTTPS hosts (the model provider and the
  callback host are added automatically)

## Cloud-session host environment

Set by the backend for a host machine. `DRAFT_MODE=host` selects this mode.

- `DRAFT_MODE=host`
- `DRAFT_API_BASE_URL`: the backend API, an `https` URL on port 443. Its host is
  allowed through the egress policy.
- `DRAFT_SESSION_ID`, `DRAFT_WORKSPACE_ID`: the session the host serves.
- `DRAFT_RUN_TOKEN`: the host's bearer token for the backend's host endpoints
  (scope `host`). The host removes it from the pane's environment.
- `DRAFT_MCP_URL`, `DRAFT_MCP_TOKEN`: Draft's tool server, and the agent's token
  for it (scope `mcp`). The host writes `draft` into the user scope of
  `$HOME/.claude.json` with `Authorization: Bearer ${DRAFT_MCP_TOKEN}`, so the
  token stays in the environment. The pane keeps `DRAFT_MCP_TOKEN`. The URL must
  be on the `DRAFT_API_BASE_URL` host.
- `DRAFT_SEED`: JSON. Either `{"kind":"repo","gitRemote":"...","branch":"..."}`
  or `{"kind":"snapshot","url":"https://..."}`. The git or snapshot host is
  allowed through the egress policy.
- `DRAFT_NETWORK`: `restricted` (the default) or `open`.
- `DRAFT_EGRESS_HOSTS`: extra hosts for `restricted`, comma or space separated.
- The harness login: `CLAUDE_CODE_OAUTH_TOKEN` or `CODEX_AUTH_JSON`.

The entrypoint sets `HOME=/data` and `DISABLE_AUTOUPDATER=1`. The host refuses
to start unless `HOME` is `/data` or under it.

GitHub access for `git` and `gh` comes from `draft-github-token`. The system git
config sends github.com credentials to `git-credential-draft`, which calls it.
It asks the backend's `github.credential` tool with `DRAFT_MCP_TOKEN` (or
`DRAFT_RUN_TOKEN` in a routine). The host's seed clone uses the same path, so a
private seed repo clones.

## What the host branch does

`entrypoint.sh` runs these steps in order when `DRAFT_MODE=host`:

1. Checks that `DRAFT_NETWORK` is `restricted` or `open`.
2. Creates `/data/.draft/bin` and gives `/data` and `/data/.draft` to the
   `agent` user. The first boot of a volume starts empty, so this step runs on
   every boot.
3. Links `/data/.draft/bin/tmux` to `/usr/bin/tmux`.
4. Reads the API host and the seed host. Node parses both. Its errors are not
   printed, because they can echo `DRAFT_SEED`.
5. Runs the egress policy (below).
6. Runs `exec gosu agent env HOME=/data DISABLE_AUTOUPDATER=1 /usr/local/bin/bun /opt/draft/host.mjs`.

## How the host finds tmux and Claude

- **tmux.** `core/src/host/launch.ts` runs `$HOME/.draft/bin/tmux` and does not
  search PATH. The entrypoint links that path to the system tmux.
- **claude.** `core/src/host/find-bin.ts` checks `$HOME/.local/bin`,
  `/usr/local/bin`, `/opt/homebrew/bin`, `$HOME/.npm-global/bin`, and the nvm
  paths. The Dockerfile installs `claude` and `codex` globally, so they land in
  `/usr/local/bin`. That path is found with `HOME=/data`, and no link is needed.

## Egress

Root configures IPv4 and IPv6 policies before any agent code runs.

- **Restricted** (`configure-egress.sh`). Default deny for outbound traffic.
  Only HTTPS (port 443) to the allowed hosts is open. The hosts are resolved
  while the machine is online and pinned in `/etc/hosts`. Network DNS is then
  blocked. Host mode allows:
  - `api.anthropic.com`, `chatgpt.com`, `auth.openai.com`, `api.openai.com`. The
    harness is chosen per session after boot, so both providers are open.
  - The API host and the seed host (the git remote or the snapshot URL).
  - Hosts from `DRAFT_EGRESS_HOSTS`.
- **Open** (`configure-open-egress.sh`). Any destination is allowed, except:
  - `10/8`, `172.16/12`, `192.168/16` and `169.254/16`, which covers the
    metadata address `169.254.169.254`.
  - `fc00::/7` and `fe80::/10`, which cover Fly's 6PN `fdaa::/16` and the AWS
    IPv6 metadata address `fd00:ec2::254`.
  - The resolvers in `/etc/resolv.conf` are accepted before the blocks, because
    Fly's resolver is in `fdaa::/16`. DNS therefore still works. Other DNS
    servers are not blocked in this mode.

Both scripts fail closed when `iptables` or `ip6tables` is missing.

## Failures

Routine mode: any error after the callback variables are read is posted to the
callback as `{ error: "runner_error", diagnostics: { reason } }` and logged with
the same reason. In a batch, a single item that throws becomes an `ok: false`
item and the rest of the batch still reports.

Run one-shot Machines with `--rm`. Fly's default restart policy is wrong for
jobs.

Host mode: the host retries its first session load and its first heartbeat up to
five times, waiting 1, 2, 4, 8 and 16 seconds. It retries network failures and
5xx responses only. A 4xx fails at once. After the last failed try, the host
ends the session with `host_failed`.

## Build and validate (from `backend`)

Both bundles must exist before the image builds. The Dockerfile copies both.

```sh
bun test src/__tests__/sandbox src/__tests__/metaharness/sandbox
bun run build:runner
bun run build:host
sh -n src/sandbox/image/entrypoint.sh src/sandbox/image/configure-egress.sh src/sandbox/image/configure-open-egress.sh
docker build src/sandbox/image
```
