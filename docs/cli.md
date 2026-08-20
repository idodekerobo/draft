# CLI Reference

The `draft` CLI is a thin client for the hosted Draft control plane. It authenticates via device pairing and reads your workspace's context. It does not run a local daemon and does not store your context locally — reads always go through the hosted API.

Run `draft --help` for a quick reference.

---

## Authentication

### `draft auth login`

Signs in via device pairing: opens a pairing URL, polls until you approve it in the browser, then stores credentials locally at `~/.draft/personal/cli-auth.json`.

```bash
draft auth login
draft auth login --force    # start a new pairing flow even if a session is already stored
draft auth login --json     # JSON Lines: one pairing_required line, then one terminal line
```

If a stored session is already valid, `login` reuses it (a live `whoami` call) instead of starting a new pairing flow. `--force` always starts fresh.

Never prompts for a password and never blocks on stdin — pairing is approved in the browser.

### `draft auth whoami`

Shows the current signed-in identity. Always makes a live API call — cached identity is never treated as authoritative on its own.

```bash
draft auth whoami
draft auth whoami --json
```

### `draft auth logout`

Revokes the local Supabase session and clears `~/.draft/personal/cli-auth.json`.

```bash
draft auth logout
draft auth logout --json
```

If the remote revoke fails, local credentials are still cleared, but the command exits nonzero (`partial_logout`) since the remote token may remain valid until it expires.

---

## Context

### `draft context list`

Lists the context dimensions available in your workspace (e.g. `company`, `product`, `team`) — discovered dynamically from the latest context snapshot, not a fixed set.

```bash
draft context list
draft context list --json
```

### `draft context read`

Prints one or more context dimensions.

```bash
draft context read --dimension product
draft context read --dimension product --dimension team
draft context read --all
draft context read --dimension product --json
```

Pass one or more `--dimension <name>` flags, or `--all` — exactly one selection mode is required. Unknown dimension names fail atomically (no content is printed, and the error lists both the requested and available names) before anything is printed.

---

## Sessions

Captures Claude Code coding sessions from a project into your workspace, so they're readable from the CLI (and, later, summarized and searchable). Only `claude-code` has a real install path today — other agent names in the `add`/`sessions` vocabulary (`codex`, `cursor`, `openclaw`, `hermes`) are accepted but rejected with a clear "not yet supported" error.

### `draft sessions enable <agent> [--dir <path>] [--json]`

Turns on session capture for one project: mints a repo-scoped ingest token, writes `.claude/draft/config.json` and `.claude/draft/capture-session.sh`, and adds a `SessionEnd` hook entry to `.claude/settings.json` (preserving any hooks already there). It never runs `git add`/`git commit` — review the diff and commit it yourself.

```bash
draft sessions enable claude-code --dir ~/code/my-app
draft sessions enable claude-code --dir . --json
```

Re-running is idempotent: the hook entry is only added once (`hookChanged: false` on a no-op rerun).

### `draft sessions disable [--dir <path>] [--json]`

Removes the `SessionEnd` hook entry from `.claude/settings.json`. The repo's ingest token stays active server-side — revoking it isn't wired up yet (no settings UI to drive it from).

```bash
draft sessions disable --dir ~/code/my-app
```

### `draft sessions status [--dir <path>] [--json]`

Reports whether a project has session capture configured and whether the `SessionEnd` hook is installed.

```bash
draft sessions status --dir ~/code/my-app
```

### `draft sessions list [--provider <name>] [--user <email>] [--since <iso8601>] [--json]`

Lists captured sessions in your workspace, most recent first. `--user` takes an email address, resolved against both an authenticated user's `users.email` and an unverified contributor's `session_contributors.git_email` — not a raw user id.

```bash
draft sessions list
draft sessions list --provider claude-code-session --json
draft sessions list --user ada@example.com
```

### `draft sessions read <id> [--summary | --transcript] [--json]`

Prints one session's summary (default) or its raw transcript.

```bash
draft sessions read <session-id>
draft sessions read <session-id> --transcript
```

A session that hasn't been summarized yet prints `(no summary yet)`; `--transcript` always works off the raw captured messages, regardless of summary state.

#### `--grep`, `--context`, `--max-bytes` (transcript only)

Filter a transcript before reading it back, instead of fetching the whole thing:

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

Every command accepts `--json`. Except `auth login` (which streams JSON Lines — one `pairing_required` object, then one terminal object), every `--json` invocation writes exactly one JSON object to stdout with `schema_version: 1`. stdout carries JSON only in `--json` mode; human-readable errors go to stderr.

**Exit codes:** `0` success · `1` authentication/API/operational error · `2` invalid usage · `130` interrupted (Ctrl+C during `auth login`).

---

## See also

- [Architecture](./architecture.md)
- [Agent plugins](./agent-plugins.md)
