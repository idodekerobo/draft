# Draft CLI

The Draft CLI is a thin authenticated client for the hosted or self-hosted Draft control plane. It is useful for scripts, agents, project setup, and coding-session access without opening the desktop app.

The CLI is also the current agent connection mechanism. That surface is evolving, so prefer the command help and this reference over older daemon or GitHub-sync documentation.

## Install

~~~bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
~~~

Released binaries currently support macOS arm64/x64 and Linux x64. The compiled binary is installed under ~/.draft/bin/draft and linked onto PATH.

## Configuration

The CLI defaults to:

- API: https://api.draftai.us
- App: https://app.draftai.us

For another deployment, set:

~~~env
DRAFT_API_BASE_URL=https://api.example.com
DRAFT_APP_URL=https://app.example.com
DRAFT_SUPABASE_URL=https://your-project.supabase.co
DRAFT_SUPABASE_PUBLISHABLE_KEY=your-public-key
~~~

The Supabase URL and publishable key are required by the compiled/source CLI auth path. They are public client values; never use the Supabase secret key in the CLI.

## Authentication

~~~bash
draft auth login
draft auth whoami
draft auth logout
~~~

Authentication uses browser/device pairing and stores the CLI session separately from desktop authentication.

## Context

~~~bash
draft context list
draft context read --dimension product
draft context read --all
~~~

Context reads go through the authenticated API and return the current workspace snapshot. A missing workspace is an account/onboarding state, not a local initialization step.

## Project agent setup

Use draft add to write a managed Draft context block to a project's instruction file:

~~~bash
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
draft add cursor --dir /path/to/project
~~~

The command is project-local. It does not install a global daemon or initialize a local company-brain repository. The generated instructions tell the agent how to use the CLI to read the current workspace.

## Coding sessions

Enable Claude Code session capture for a project:

~~~bash
draft sessions enable claude-code --dir /path/to/project
draft sessions status --dir /path/to/project
draft sessions disable --dir /path/to/project
~~~

The enable command writes a project-local capture script and SessionEnd hook. The hook reads the completed transcript locally and posts it to the configured API.

List and inspect captured sessions:

~~~bash
draft sessions list
draft sessions search "pattern"
draft sessions read <session-id> --summary
draft sessions read <session-id> --transcript
~~~

Session listing and reading are workspace-scoped and require authentication.

## Output and updates

Commands support --json for machine-readable output. draft update checks for and installs a newer compiled release. Updates replace the CLI binary; they do not replace the server-side workspace.

```bash
draft sessions read <session-id> --transcript --grep "database migration"
draft sessions read <session-id> --transcript --grep "error" --context 3
draft sessions read <session-id> --transcript --max-bytes 20000
```

- `--grep "<pattern>"` — case-insensitive regex match against raw message content. A malformed pattern returns a usage error, not a crash.
- `--context <n>` — include `n` messages before/after each match (default 0). Requires `--grep`. Overlapping windows are merged; the JSON response's `windows: [{start_seq, end_seq}]` array marks the returned ranges explicitly, since the result usually isn't a contiguous transcript.
- `--max-bytes <n>` — cap the serialized response size, truncating from the end. Composes with `--grep`: filtering happens first, then truncation if the filtered result is still too large. `truncated_bytes` in the JSON response reports how much was cut.

These three flags only apply with `--transcript` — combining any of them with `--summary` is a usage error.

### `draft sessions search "<pattern>"  [--provider <name>] [--user <email>] [--since <iso8601>] [--json]`

Searches session **summaries** by keyword — a different corpus than `sessions read --transcript --grep`:

| Command | Corpus | Backed by |
|---|---|---|
| `sessions search` | summaries (`source_items.content_markdown`) | GIN tsvector index |
| `sessions read --transcript --grep` | raw turns (`agent_messages.content`) | sequential scan, one session |

`search` never returns full summary text — only a short snippet around each match, so it stays cheap to skim across many sessions. Use `sessions read <id>` to fetch a session's full summary once you've found the one you want.

```bash
draft sessions search "database migration"
draft sessions search "auth bug" --since 2026-08-01
```

List sessions and read summaries first. Fetch a full transcript, or use `--grep`, only when the summary is missing, stale, or insufficient.

---

## Project setup

### `draft add <tool> [--dir <path>...] [--json]`

Configures a project so its coding agent can discover Draft and the commands it may call (`draft auth login`, `draft context list`, `draft context read`). It does **not** install the `draft` CLI binary (installed separately — see [Running from source](../README.md#running-from-source)), does not run or bootstrap a background daemon, and does not touch global tool configuration. It writes to exactly one file, in exactly the directories you pass.

```bash
draft add claude-code --dir ~/code/my-app
draft add codex --dir ~/code/my-app --dir ~/code/another-app
draft add cursor --dir .
draft add openclaw --dir . --json
```

`--dir` is repeatable — pass it once per project you want to configure. If you omit it in an interactive terminal, you're prompted for one or more directories (defaulting to the current directory). Without a TTY (e.g. in a script or CI), a missing `--dir` fails immediately with exit code `2` — it never waits on stdin.

Each directory must already exist; a missing path, a path that isn't a directory, or an instruction-file target that is a symlink is rejected for that directory without touching it.

**Tool → instruction file:**

| Tool | File |
| --- | --- |
| `claude-code` | `CLAUDE.md` |
| `codex` | `AGENTS.md` |
| `cursor` | `AGENTS.md` |
| `openclaw` | `AGENTS.md` |
| `hermes` | `HERMES.md` |

`draft add` appends or updates one short, sentinel-delimited Draft-managed block in that file — it only points the agent at the CLI commands above, it never copies or embeds context content into the file. Everything outside the sentinels (your own instructions) is preserved byte-for-byte. The block is identical across tools, so `draft add codex --dir .` followed by `draft add cursor --dir .` converge on the same `AGENTS.md` block rather than duplicating it, and running the same command twice makes no write once the block is already current.

```bash
draft add codex --dir ./my-repo
draft add cursor --dir ./my-repo   # updates the same AGENTS.md block, no duplicate
```

```json
$ draft add claude-code --dir ./my-repo --json
{"schema_version":1,"status":"ok","tool":"claude-code","results":[{"dir":"./my-repo","ok":true,"file":"/abs/path/my-repo/CLAUDE.md","changed":true}]}
```

If any of the given directories fail validation, `status` is `partial_error`, each directory's own result reports `ok` and, on failure, a `code` (`directory_not_found`, `not_a_directory`, or `symlink_target`) and `message` — directories that did validate are still written. Exit code is `1` if any directory failed, `0` if all succeeded.

---

## Hosted integrations

`draft integrations` connects and manages the hosted control plane's own data
sources — GitHub, Linear, Slack, Fireflies, and Claude Code. This is
different from `draft add`: `add` points a coding agent *inside a project* at
the CLI's read commands (`auth login`, `context list`, `context read`);
`integrations` is workspace-level and has nothing to do with any one
project's directory. Most `integrations connect` flows need a human at a
terminal — a browser handoff, a hidden credential prompt, or both — so
running them unattended (e.g. from an agent) usually isn't the right call
unless you're prepared to babysit the prompts.

### `draft integrations list [--json]`

Lists all five providers and their status — `disconnected`, `pending`,
`connected`, `degraded`, or `error`. Slack connections also report their
current `channel_ids`.

**Fireflies stays `pending` until it has proof the webhook actually
works** — not just until credentials are stored. The backend flips it to
`connected` only after Fireflies calls the webhook back for a real
`meeting.transcribed`/`meeting.summarized` event; pressing Enter to finish
`connect fireflies` confirms you did the manual setup step, but can't prove
the webhook is live. Expect `pending` until your next meeting is
transcribed or summarized.

```bash
draft integrations list
draft integrations list --json
```

### `draft integrations connect <provider> [--json] ...`

| Provider | Extra flags | TTY-only? | Terminal status on success |
| --- | --- | --- | --- |
| `github` | `--no-open` | No (polls; no credential prompt) | `connected` |
| `linear` | `--credential-stdin` \| `--credential-fd <n>` | No | `connected` |
| `claude-code` | `--credential-stdin` \| `--credential-fd <n>` | No | `credential_stored` (not live-validated) |
| `slack` | `--no-open`, `--credential-stdin` \| `--credential-fd <n>` | No, but channel selection only runs on an attended TTY | `connected` |
| `fireflies` | `--no-open` | **Yes — always** | `credentials_stored_webhook_pending` |

Omitting `<provider>`, or passing one that isn't in the table above, fails
immediately with `invalid_connect_usage` (exit `2`) and prints the exact
list of valid providers — it never falls through to any one provider's
flow by default.

```bash
draft integrations connect github                        # prints install-app guidance, then waits for install
draft integrations connect github --no-open --json      # print the install URL instead of opening a browser

draft integrations connect linear                        # prompts for a Linear API key on the terminal
echo '{"api_key":"..."}' | draft integrations connect linear --credential-stdin --json

draft integrations connect claude-code
echo '{"setup_token":"..."}' | draft integrations connect claude-code --credential-stdin

draft integrations connect slack                         # opens the Slack app-manifest page, then prompts for
                                                           # xoxb-/xapp- tokens, then an interactive channel picker
draft integrations connect slack --credential-fd 3 3<tokens.json   # automation mode — channel_ids default to []

draft integrations connect fireflies                      # requires an attended terminal end to end
```

`github`, `linear`, `claude-code`, and `slack` accept `--credential-stdin` (a
single JSON object on stdin) or `--credential-fd <n>` (the same, on an
inherited file descriptor ≥ 3) as an alternative to the interactive hidden
prompt — useful for scripting. **`fireflies` accepts neither.** Reconnecting
Fireflies rotates its webhook secret, invalidating the one already configured
on Fireflies' side, so the flow needs a human to confirm the rotation, paste
the new token, and copy the newly generated webhook URL/secret out of a local
handoff page — none of that can be scripted, so the CLI requires a real
terminal and fails immediately with `credential_input_required` (exit `2`)
if one isn't attached, before making any network call.

`--no-open` (github, slack, fireflies) prints the browser/handoff URL instead
of opening it — useful over SSH or in a container. In every case where a
browser or local page can't be opened, the CLI falls back to printing the
URL so you can open it yourself; it never blocks waiting for a browser that
didn't launch.

Every hidden-credential prompt (linear, claude-code, slack, fireflies) prints
where to find the value before asking for it — a settings URL, or for
`slack` which OAuth screen each token comes from — states plainly that the
prompt is hidden (input isn't echoed to the screen), and confirms that
Ctrl+C cancels it. This guidance is written straight to the terminal, not
into the `--json` stdout stream, so it shows up even with `--json` set as
long as the interactive prompt is what's actually running; it's only
skipped entirely when credentials come via `--credential-stdin`/
`--credential-fd` instead.

**GitHub** allows only one active installation per workspace — connecting a
second one while the first is still active fails with
`github_installation_conflict` (exit `1`); disconnect the existing one first.
After the browser opens, the CLI prints what to do there (install the app,
grant repo access), then "Waiting for installation." while it polls for
completion — it resolves to `connected` or an error once you finish the
install in the browser.

**Slack**'s channel picker (during `connect slack`, and during
`slack channels set` with no IDs given) only runs when you're at an attended
terminal; scripted/automated runs default to an empty channel selection
(`[]`) rather than prompting. Slack message capture depends on exactly one
backend replica holding the account's Socket Mode connection at a time —
this doesn't affect the CLI directly, but it's why a fresh `connect`/
`channels set` may take a moment to show captured activity after a backend
deploy.

**Fireflies** ends in `credentials_stored_webhook_pending`, not `connected`
— the CLI stores the token and shows you the webhook details, but can't
verify you actually finished pasting them into Fireflies. It opens (or
prints, with `--no-open`) a local handoff page with the webhook URL and
secret, and both the page and the terminal spell out the Fireflies webhook
settings URL (`https://app.fireflies.ai/integrations/api/webhook`) and the
two events to enable — Meeting Transcribed and Meeting Summarized. Re-running
`connect fireflies` on an existing connection always warns before rotating
the secret (`y`/`N` at the terminal); declining exits `1` with `cancelled`
and makes no request. See `integrations list` above for why the connection
still shows `pending` after this succeeds.

### `draft integrations disconnect <provider> [--json]`

```bash
draft integrations disconnect github
draft integrations disconnect linear --json
```

Supported for `github`, `fireflies`, `linear`, `slack` — each makes a real
request and reports `disconnected`. `claude-code` is a recognized argument
(not a grammar error) but always reports `not_supported` (exit `1`) and
makes **no** network call — there's no live Claude Code credential to
revoke server-side.

### `draft integrations slack channels list [--json]`

Lists the connected Slack workspace's channels — `id`, `name`,
`memberCount`, `isMember` — as seen by the backend today.

```bash
draft integrations slack channels list
```

### `draft integrations slack channels set [<channel-id>...] [--json]`

Replaces the bot's channel membership with exactly the given set (not a
diff — omitted channels are left). Given no IDs at all: on an attended
terminal, lists the current channels and offers the same interactive picker
as `connect slack`; without a TTY, defaults to `[]` (leaves every channel).

```bash
draft integrations slack channels set C0123 C0456
draft integrations slack channels set                # interactive picker (TTY) or [] (automation)
```

A join/leave that fails for one channel doesn't fail the whole command —
the response's `failed` array (and a printed warning per failure) reports
which channels didn't converge; retrying `channels set` with the same
target set is safe and will retry only what didn't converge.

### JSON Lines event vocabulary

`--json` writes one `{"schema_version":1, ...}` object per line to stdout.
A `connect` flow that needs a browser or local handoff prints one or more
progress lines first, then a terminal line:

```json
{"schema_version":1,"status":"browser_required","provider":"github","url":"https://github.com/apps/.../installations/new?state=...","expires_in_seconds":300}
{"schema_version":1,"status":"awaiting_install","provider":"github"}
{"schema_version":1,"status":"connected","provider":"github"}
```

```json
{"schema_version":1,"status":"handoff_required","provider":"fireflies","url":"file:///tmp/draft-fireflies-XXXXXX/index.html","opened":true}
{"schema_version":1,"status":"credentials_stored_webhook_pending","provider":"fireflies"}
```

`browser_required` is used by `github`/`slack` (a real, remote URL);
`handoff_required` is fireflies-only (a local `file://` page — the webhook
secret is written into that page, never printed to stdout/stderr by the
CLI itself). A `connected` event for Linear may also carry
`"cleanup_pending":true` if a prior webhook couldn't be auto-removed during
a credential-rotation reconnect — the new connection is still authoritative
and usable; cleanup retries automatically.

**Error codes worth knowing beyond the general set:** `invalid_connect_usage`
(`connect` called with no provider or an unrecognized one, exit `2`),
`credential_input_required`
(no TTY and no `--credential-stdin`/`--credential-fd`, exit `2`),
`invalid_credential_input` (malformed hidden-input JSON or a token that
fails a provider's own format check, exit `2`), `cancelled` (declined a
confirmation prompt, exit `1`), `workspace_changed` (the signed-in workspace
changed mid-flow, exit `1`), `github_installation_conflict` (exit `1`),
`aborted`/`interrupted` (Ctrl+C, exit `130`).

---

## Installing and updating

The CLI installs standalone — no repo clone, no bun, no desktop app required:

```bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
```

This downloads the platform-matched `draft` binary from the latest GitHub release (the same release `make desktop-release` cuts for the desktop app) to `~/.draft/bin/draft` and links it onto `PATH` — the same layout the desktop app's own first-launch installer uses, so either install path works interchangeably with `draft update`.

### `draft update`

Downloads the latest release binary for your platform and replaces the running `draft` in place.

```bash
draft update            # install the latest version
draft update --check    # report whether an update is available, without installing
draft update --json
```

Every other command also does a cheap, cached, non-blocking staleness check in the background and prints a one-line notice to stderr (`Update available: vX → vY — run draft update`) when a newer release is cached as available — nothing waits on the network to run your actual command. `draft --version` prints the installed version. Not available when running from source (`bun run src/index.ts`) — only applies to a compiled release binary.

---

## Other commands

### `draft completion`

Outputs a shell completion script for `draft` commands.

```bash
draft completion            # bash completion
draft completion --zsh      # zsh completion
```

Follow the printed instructions to install into your shell profile.

---

## Machine-readable output

Every command accepts `--json`. Most `--json` invocations write exactly one JSON object to stdout with `schema_version: 1`. A few stream JSON Lines instead — one object per line, ending with a terminal line: `auth login` (one `pairing_required` line, then one terminal line) and `integrations connect github`/`slack`/`fireflies` (one `browser_required`/`handoff_required` line, plus `awaiting_install`/`awaiting_credentials` progress lines for some providers, then one terminal line) — see [Hosted integrations](#hosted-integrations) above. stdout carries JSON only in `--json` mode; human-readable errors go to stderr.

**Exit codes:** `0` success · `1` authentication/API/operational error · `2` invalid usage · `130` interrupted (Ctrl+C — during `auth login`, or during an `integrations connect`/`slack channels set` prompt).

---

## See also

- [Architecture](./architecture.md)
- [Agent plugins](./agent-plugins.md)
