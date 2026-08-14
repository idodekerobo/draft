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

## Tool setup

### `draft add <tool>`

Installs Draft into an agent tool. Run once per tool. Safe to re-run after updates (idempotent).

```bash
draft add claude-code
draft add codex
draft add cursor
draft add openclaw
draft add hermes
```

See [Agent plugins](./agent-plugins.md) for full details on each tool.

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
