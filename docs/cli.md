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

Validates and activates a named workspace profile, removes team assets owned by
the old profile, and installs the new profile's team skills and MCP servers into
Claude Code and Codex.

```bash
draft switch acme
draft switch acme --json
```

Missing MCP credentials and personal-name collisions produce a successful
partial activation: the profile becomes active, unaffected assets install, and
personal assets are preserved. Restart active agent sessions after switching.

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

## Dimension management

### `draft dimension`

Manage context dimensions in the active workspace.

```bash
draft dimension list              # list all dimensions and their status
draft dimension add <name>        # scaffold a new dimension
```

`draft dimension list` shows all subdirectories of `context/`, marking each as initialized (has an `index.md`) or uninitialized (folder exists but no `index.md`).

`draft dimension add <name>` creates `context/<name>/index.md` with a blank frontmatter template and `context/<name>/log/`. Safe to run on an existing folder — only adds missing files, never overwrites. Dimension names may only contain lowercase letters, numbers, and hyphens.

Equivalent skill: `/draft:add-dimension <name>` (AI-powered — also seeds initial context).

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

Publishes accepted proposals, current context, profile-owned `skills/`, and
`config/mcp.json` in one repository transaction. Deletions are included.

```bash
draft publish
draft publish --json
```

Requires collaboration to be configured and `gh` to be authenticated.
`config/secrets.json` and `config/local.json` are never copied. Accepted files,
publish timestamps, and team-asset baselines are updated only after the push
succeeds.

### `draft load`

Pulls the latest team context and profile-owned assets from the shared GitHub
repo, mirrors additions and deletions into the active profile, then installs the
active team assets.

```bash
draft load
draft load --json
draft load --discard-team-assets
```

Load stops if profile-owned assets differ from the last published/loaded
baseline. Publish those edits first, or explicitly discard them with
`--discard-team-assets`. Personal Claude Code and Codex assets never block load
and win name collisions.

SessionStart runs `draft load --session-start`. This mode never prompts, never
discards unpublished assets, writes a notification for skipped or partial
loads, and does not block agent startup.

Team MCP credentials are stored per profile in `config/secrets.json` and are
never published. Missing credentials leave the MCP pending while the rest of
the profile remains usable.

---

## Import

### `draft import`

Import markdown content from a local directory or private GitHub repo into your workspace as a reviewable proposal.

```bash
draft import ~/notes                    # import from local directory
draft import owner/private-repo         # import from GitHub repo
draft import ~/notes --preview          # preview without writing
```

Files are mapped to Draft dimensions using directory name and filename heuristics (e.g. a `product/` subdirectory maps to the `product` dimension). Files that don't map to any known dimension are listed as unmapped in the proposal.

For GitHub repos, requires `gh` CLI to be authenticated (`gh auth login`). The repo is cloned to a temp directory, read, and deleted — nothing persists outside your workspace.

The import is always staged as a proposal — run `draft proposals` to review and accept or reject before any context files are changed.

Equivalent skill: `/draft:import <source>` (AI-powered — uses judgment for dimension mapping instead of heuristics).

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
