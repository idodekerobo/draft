# CLI Reference

The `draft` CLI is a compiled Bun binary installed to `/usr/local/bin/draft` (symlinked from `~/.draft/bin/draft`). It provides terminal access to everything in the desktop app, plus a few power-user commands only available via CLI.

Run `draft --help` for a quick reference.

---

## Daemon commands

### `draft status`

Shows the current state of the daemon and all configured integrations.

```
  Draft daemon
  ────────────────────────────────────
  ●  Daemon        running (pid 12345)
  ◯  Profile       acme

  Integrations
  ●  Granola       connected (mcp)
  ◯  Slack         not connected
  ●  GitHub        connected
```

### `draft start`

Starts the background daemon. Delegates to `background/start.sh`, which loads the LaunchAgent plist via `launchctl`. The daemon must be installed first (`draft add claude-code`).

```bash
draft start
```

### `draft stop`

Stops the background daemon by unloading the LaunchAgent via `launchctl`. The daemon will not restart until you run `draft start` or reboot (the plist uses `KeepAlive: true`, but unloading overrides it).

```bash
draft stop
```

### `draft logs`

Tails the daemon log.

```bash
draft logs              # show last 50 lines
draft logs --follow     # stream live (Ctrl+C to stop)
draft logs -f           # same as --follow
draft logs --errors     # show the stderr log instead
```

Log files are at `~/.draft/background/logs/daemon.log` and `daemon-error.log`.

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

For `claude-code`, this:
1. Installs the background daemon (runs `install.sh` if not yet installed).
2. Prompts for a workspace profile name on first install.
3. Populates `~/.draft/shared/` with skills, agents, and hook scripts.
4. Symlinks skills into `~/.claude/skills/` and agents into `~/.claude/agents/`.
5. Merges hooks, env vars, and permissions into `~/.claude/settings.json`.
6. Registers the tool in `~/.draft/config.json`.

For `codex` and `cursor`, delegates to the tool-specific setup scripts.

For `openclaw`, this:
1. Merges `~/.draft/shared/skills/` into `skills.load.extraDirs` and `allowSymlinkTargets` in `openclaw.json`.
2. Registers `draft-learner` and `draft-researcher` in `agents.list[]` in `openclaw.json`.
3. Appends a managed context block to `~/.openclaw/workspace/AGENTS.md`.
4. Installs the OpenClaw lifecycle plugin (`session_start` injection + `session_end` synthesis trigger).

For `hermes`, this:
1. Merges `~/.draft/shared/skills/` into `skills.external_dirs` in `~/.hermes/config.yaml`.
2. Appends a managed context block to `~/.hermes/SOUL.md`.
3. Copies the Hermes plugin to `~/.hermes/plugins/draft/` (`on_session_start` env injection + `on_session_end` synthesis trigger).

See [Agent plugins](./agent-plugins.md) for full details on each tool.

---

## Profile management

### `draft switch <name>`

Activates a named workspace profile. Takes effect on the next Claude Code session restart (because `~/.claude/settings.json` is read at startup).

```bash
draft switch acme
draft switch personal
```

### `draft profiles`

Subcommands for managing profiles.

```bash
draft profiles list                    # list all profiles (* marks active)
draft profiles create <name>           # create a new blank profile
draft profiles rename <old> <new>      # rename a profile
draft profiles delete <name>           # delete a profile
draft profiles delete <name> --force   # delete the active profile
```

Profile names may only contain letters, numbers, hyphens, and underscores.

Deleting the active profile requires `--force`. Consider switching to another profile first.

---

## Proposals

### `draft proposals`

Interactively review pending AI-generated context proposals — the output of synthesis after a session ends or an integration poll runs.

```bash
draft proposals
```

Displays proposals one at a time with a diff preview. Keypresses:

| Key | Action |
|-----|--------|
| `a` | Accept — moves to `accepted/`, attempts immediate publish to team repo |
| `r` | Reject — moves to `rejected/` |
| `s` | Skip — leaves proposal in `proposals/` for later |
| `q` | Quit |

If `gh` is authenticated and a team repo is configured, accepted proposals are immediately committed to the shared repo. If not, they wait in `accepted/` until `draft publish` is run.

---

## Team sync

### `draft publish`

Pushes all accepted proposals to the team's shared GitHub repo.

```bash
draft publish
```

Requires collaboration to be configured (`/draft:setup-collab`) and `gh` to be authenticated. Commits each accepted proposal file and removes it from `accepted/` on success. On partial failure, stops and prints which file failed — run `draft publish` again to retry.

### `draft load`

Pulls the latest team context from the shared GitHub repo.

```bash
draft load
```

Does a shallow clone of the team repo, reads the change log since your last load cursor, and applies teammates' accepted updates to your local workspace. This is also run automatically at every session start via a `SessionStart` hook (with a 30-second timeout so it never blocks a session).

---

## Integration polling

### `draft poll <integration>`

Triggers an on-demand poll for a connected integration, without waiting for the daemon's scheduled interval.

```bash
draft poll github
draft poll granola
draft poll slack
```

Useful when you want to pull in new data immediately — for example, after a meeting ends or after merging a PR. Run `draft proposals` afterward to review any new context updates.

---

## Diagnostics

### `draft doctor`

Runs a full health check across six groups and prints pass/fail for each, with suggested fixes for anything broken.

```bash
draft doctor
```

**Checks:**

| Group | What it checks |
|-------|---------------|
| Runtime dependencies | `tmux`, `claude` CLI, `bun`, `gh` CLI |
| Daemon | LaunchAgent plist exists, daemon registered, daemon running, log dir writable |
| Config | `active-profile` readable, workspace dir exists, `secrets.json` valid JSON and `chmod 600` |
| Integrations | Granola MCP registered (if MCP mode), Slack capture process running |
| Installed tools | Tools registered in `config.json` with marker files present |
| Plugin files | `~/.draft/shared/` present, symlinks in `~/.claude/skills/` and `~/.claude/agents/` not broken |

Run `draft doctor` after initial setup and any time something isn't working to get a diagnosis.

---

## Updates

### `draft update`

Updates Draft to the latest version.

```bash
draft update
```

1. `git pull origin main` from the repo.
2. Runs `bun install` to update dependencies.
3. Re-runs `draft add <tool>` for each installed tool to refresh plugin files.
4. Writes the new version to `~/.draft/config.json` and `~/.draft/version`.

Never touches workspace context files (`~/.draft/workspaces/`). Safe to run at any time.

---

## Other commands

### `draft uninstall`

Removes Draft from the system. Unloads the daemon, removes the LaunchAgent plist, and optionally removes the `~/.draft/` directory and tool config entries.

```bash
draft uninstall
```

### `draft completion`

Outputs shell completion script for `draft` commands.

```bash
draft completion bash   # bash completion
draft completion zsh    # zsh completion
```

Follow the printed instructions to install into your shell profile.

---

## See also

- [Architecture](./architecture.md)
- [Agent plugins](./agent-plugins.md)
- [Setting up collaboration](./setting-up-collaboration.md)
