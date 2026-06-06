# Agent Plugins

Draft integrates with Claude Code, Codex, Cursor, OpenClaw, and Hermes by installing a plugin into each tool's local config. The plugin does two things: injects your workspace context at the start of every session, and queues a synthesis job when the session ends.

All plugins point back to `~/.draft/shared/` — a single directory that is the source of truth for skills, agents, and hook scripts. When Draft updates, only `shared/` changes; all tool configs pick up the new files automatically via symlinks.

---

## Installing a plugin

```bash
draft add claude-code
draft add codex
draft add cursor
draft add openclaw
draft add hermes
```

Each command is idempotent — safe to re-run after updates. The install flow is described per-tool below.

---

## Claude Code

**Install command:** `draft add claude-code`

### What gets installed

| What | Where |
|------|-------|
| Skills | `~/.claude/skills/draft-*/` → symlinked from `~/.draft/shared/skills/` |
| Agents | `~/.claude/agents/draft-*.md` → symlinked from `~/.draft/shared/agents/md/` |
| Hooks | Merged into `~/.claude/settings.json` |
| Workspace CLAUDE.md | Copied to `~/.draft/workspaces/<profile>/CLAUDE.md` |
| Env vars | Written to `~/.claude/settings.json` under `env` |
| Permissions | Merged into `~/.claude/settings.json` under `permissions` |

### Hooks

Three hooks are registered at `SessionStart` and one at `SessionEnd` in `~/.claude/settings.json`:

```json
"SessionStart": [
  "bash session-init.sh",       // bootstrap workspace, keep settings.json current
  "bash load-team.sh",          // pull latest team context (if collab configured)
  "bash inject-context.sh"      // read context files → output to system prompt
],
"SessionEnd": [
  "bash on-session-end.sh"      // drop a synthesis job file into pending/
]
```

These run locally inside Claude Code's process — not via any Draft server or proxy.

**`session-init.sh`** runs every session:
- Reads `~/.draft/active-profile` to compute the active workspace path.
- Bootstraps the workspace directory from template if it doesn't exist yet.
- Writes the active `DRAFT_WORKSPACE` path to `settings.json` so profile switches take effect on the next restart.

**`inject-context.sh`** runs every session (see [How context injection works](./how-context-injection-works.md)):
- Reads each `context/*/index.md` frontmatter and outputs a formatted context block to stdout.
- That output becomes part of Claude's system prompt for the session.

**`on-session-end.sh`** runs when a session ends:
- Writes a `.json` job file to `~/.draft/background/pending/`.
- The daemon picks it up and runs synthesis.

### Env vars

The following env vars are written to `~/.claude/settings.json`:

| Var | Value |
|-----|-------|
| `DRAFT_WORKSPACE` | `~/.draft/workspaces/<active-profile>` |
| `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | Same — tells Claude Code to load the workspace CLAUDE.md |
| `CLAUDE_PLUGIN_ROOT` | Path to the installed plugin files |

`session-init.sh` updates `DRAFT_WORKSPACE` every session to stay in sync with the active profile.

### Permissions

The following permissions are merged into `~/.claude/settings.json`:

```json
"permissions": {
  "allow": [
    "Write(~/.draft/**)",
    "Read(~/.draft/**)",
    "Edit(~/.draft/**)"
  ],
  "additionalDirectories": ["~/.draft/workspaces/"]
}
```

These allow the agent to read and update context files directly when running skills or `draft-learner`.

### Primary agent

`draft add claude-code` sets the primary agent in `settings.json`:

```json
"agent": "draft:draft-agent"
```

This makes `draft-agent` the orchestrator for every Claude Code session. See [Agents](#agents) below.

---

## Codex

**Install command:** `draft add codex`

### What gets installed

| What | Where |
|------|-------|
| Skills | `~/.agents/skills/draft-*/` → symlinked from `~/.draft/shared/skills/` |
| Agent TOML files | Copied to `~/.codex/agents/` (TOML format, Codex-specific — not symlinked) |
| AGENTS.md | `~/.codex/AGENTS.md` → symlinked to `~/.draft/shared/codex-agents.md` |
| Hook scripts | `~/.codex/hooks/draft/` → symlinked from `~/.draft/shared/hooks/` |
| SessionStart hook | Registered in `~/.codex/hooks.json` |
| Stop hook | Registered in `~/.codex/hooks.json` |
| Feature flag | `codex_hooks = true` written to `~/.codex/config.toml` |

### Hooks

**`SessionStart`** — runs `inject-context.sh` with the matcher `startup|resume`. Injects workspace context into the session.

**`Stop`** — runs `codex-session-end.sh`, the Codex equivalent of `on-session-end.sh`. Drops a job into `pending/` for the daemon.

The `codex_hooks` feature flag must be enabled in `~/.codex/config.toml` for hooks to fire — the install script handles this.

### Agent format difference

Codex uses `.toml` agent files instead of markdown. Draft installs TOML versions of `draft-researcher`, `draft-executor`, and `draft-learner` to `~/.codex/agents/`. These are copied (not symlinked) because the format is Codex-specific and cannot share source with the markdown agents used by Claude Code.

---

## Cursor

**Install command:** `draft add cursor`

### What gets installed

| What | Where |
|------|-------|
| Context rule | `.cursor/rules/draft-context.mdc` |
| Session hook | `~/.cursor/hooks/draft/cursor-session-start.sh` |
| SessionStart hook | Registered in Cursor's hooks config |

### How injection works

Cursor uses its rules system rather than a shell-based system prompt injection. `draft-context.mdc` is a Cursor rule that instructs the agent to load context from the active workspace at session start. `cursor-session-start.sh` runs `inject-context.sh` to prepare the output.

---

## OpenClaw

**Install command:** `draft add openclaw`

Requires OpenClaw to be installed and `~/.openclaw/` to exist before running.

### What gets installed

| What | Where |
|------|-------|
| Skills path | `~/.openclaw/openclaw.json` → `skills.load.extraDirs` and `allowSymlinkTargets` updated to include `~/.draft/shared/skills/` |
| Subagents | `draft-learner` and `draft-researcher` entries added to `agents.list[]` in `openclaw.json` |
| AGENTS.md block | Draft managed block appended to `~/.openclaw/workspace/AGENTS.md` |
| Lifecycle plugin | Installed via `openclaw plugins install path:<openclaw-plugin-dir>` |

### How injection works

The OpenClaw plugin registers three hooks:

**`session_start`** — calls `inject-context.sh` and passes the output to `api.enqueueNextTurnInjection`, which injects it into the agent's first model turn. Also fires `draft start` to ensure the daemon is running.

**`session_end`** — calls `openclaw-session-end.sh`, which writes a pending record to `~/.draft/pending/openclaw-{session_id}.json`. The daemon picks it up on the next poll cycle and synthesizes proposals.

**`resolve_exec_env`** — reads `~/.draft/active-profile` at runtime and sets `DRAFT_WORKSPACE`, `DRAFT_PROFILE`, and `DRAFT_SHARED` in every tool execution environment. Profile switches take effect without reinstalling the plugin.

The `AGENTS.md` managed block contains `!bash` commands that mirror the Claude Code injection model and serve as a fallback if the plugin hook is unavailable.

### Skills

All Draft slash commands are available in OpenClaw automatically once `~/.draft/shared/skills/` is in `extraDirs`. OpenClaw discovers them at session start.

---

## Hermes

**Install command:** `draft add hermes`

Requires Hermes to be installed and `~/.hermes/config.yaml` to exist before running.

### What gets installed

| What | Where |
|------|-------|
| Skills path | `skills.external_dirs` in `~/.hermes/config.yaml` updated to include `~/.draft/shared/skills/` |
| SOUL.md block | Draft managed block appended to `~/.hermes/SOUL.md` |
| Lifecycle plugin | Copied to `~/.hermes/plugins/draft/` |

### How injection works

The Hermes plugin (`~/.hermes/plugins/draft/__init__.py`) registers two hooks:

**`on_session_start`** — reads `~/.draft/active-profile` at runtime and sets `DRAFT_WORKSPACE`, `DRAFT_PROFILE`, and `DRAFT_SHARED` as environment variables. Profile switches take effect without reinstalling the plugin. Also fires `draft start` to ensure the daemon is running.

**`on_session_end`** — calls `hermes-session-end.sh`, which writes a pending record to `~/.draft/pending/hermes-{session_id}.json`. The daemon picks it up on the next poll cycle and synthesizes proposals.

**Context delivery in SOUL.md:** `SOUL.md` is a system prompt / identity file and does not support `!bash` execution. The managed block instructs the agent to run `inject-context.sh` via bash at the start of each session to read the active workspace context.

### Skills

All Draft slash commands are available in Hermes automatically once `~/.draft/shared/skills/` is in `skills.external_dirs`. Hermes discovers them at session start.

---

## Skills (slash commands)

Draft installs a set of `/draft:*` slash commands as skills. These are available in any tool that has been set up with `draft add`.

| Skill | What it does |
|-------|-------------|
| `/draft:setup` | Guided interview to initialize or refresh all context dimensions |
| `/draft:synthesize` | Extract context updates from the current session; stage as proposals |
| `/draft:learn` | Save a specific thing to the workspace or personal memory |
| `/draft:compact` | Compact a context dimension's index.md, archiving change history to log/ |
| `/draft:profiles` | Manage profiles from inside the agent tool |
| `/draft:switch` | Switch the active workspace profile |
| `/draft:update` | Pull the latest Draft version and reinstall plugin files |
| `/draft:setup-collab` | Configure team context sharing via GitHub |
| `/draft:publish-team` | Push accepted proposals to the team repo |
| `/draft:load-team` | Pull the latest team context from the team repo |
| `/draft:connect` | Connect input source integrations (Granola, Slack, GitHub) |
| `/draft:connect granola` | Set up Granola integration (MCP or API mode) |
| `/draft:connect slack` | Set up Slack integration |
| `/draft:connect github` | Set up GitHub integration |

Skills live in `~/.draft/shared/skills/` and are surfaced per-tool:

| Tool | How skills are discovered |
|------|--------------------------|
| Claude Code | Symlinked into `~/.claude/skills/` |
| Codex | Symlinked into `~/.agents/skills/` |
| Cursor | Via Cursor rules (context block) |
| OpenClaw | `skills.load.extraDirs` in `openclaw.json` points to `~/.draft/shared/skills/` |
| Hermes | `skills.external_dirs` in `config.yaml` points to `~/.draft/shared/skills/` |

Updating Draft updates all skills without re-running `draft add`.

---

## Agents

Draft installs three sub-agents used by the `draft-agent` orchestrator:

| Agent | Role |
|-------|------|
| `draft-agent` | Main orchestrator — manages the session, delegates to sub-agents |
| `draft-executor` | Does things — writes documents, edits files |
| `draft-researcher` | Finds things — searches workspace files, fetches web content |
| `draft-learner` | Saves things — persists decisions, priorities, and memory to workspace files |

The orchestrator pattern means the user always interacts with `draft-agent`, which decides which sub-agent to delegate to based on the task. This keeps individual agents focused and avoids overloading context windows.

**`draft-learner`** is the key one from a product perspective — it's what keeps workspace context fresh without the user having to run commands. The orchestrator calls it automatically whenever something worth saving happens in a session (a decision is made, a sprint item ships, the user states a preference).

---

## Updating plugins

```bash
draft update
```

Pulls the latest from the repo and re-runs `draft add <tool>` for each installed tool. Because all plugin assets point into `~/.draft/shared/` via symlinks, the update only needs to write to `shared/` — no per-tool re-download is needed.

You can also update from inside Claude Code:

```
/draft:update
```

---

## See also

- [How context injection works](./how-context-injection-works.md)
- [Architecture](./architecture.md)
- [CLI reference](./cli.md)
