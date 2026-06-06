# Architecture

> **Platform:** macOS on Apple Silicon only. Intel Mac and Windows support is not available yet.

How the three Draft components work and how they talk to each other.

---

## Components

**Background daemon** — a long-running process registered as a macOS LaunchAgent (`com.draft.daemon`). Starts at login, restarts automatically on crash. Responsible for processing synthesis jobs and polling integrations on a schedule.

**Desktop app** — a native macOS app (tray icon + window) built with Electrobun. The main process reads `~/.draft/` directly and communicates with the UI via typed RPC. It watches the workspace for proposal changes and monitors the daemon heartbeat.

**CLI** — a compiled Bun binary at `~/.draft/bin/draft`, symlinked to `/usr/local/bin/draft`. Talks to the same files and scripts as the desktop app — there is no API server between them.

All three components read and write the same files on disk. There is no network layer between them.

---

## The daemon

The daemon does three things: processes synthesis jobs, polls integrations, and writes a heartbeat.

**Heartbeat** — every 5 seconds, it writes a JSON file to `~/.draft/background/state/last-heartbeat` with its PID, active profile, and last synthesis time. The desktop app reads this to show live status. If the file goes stale (>2 min without an update), the daemon is considered stopped.

**Job queue** — when a Claude Code session ends, the `SessionEnd` hook drops a `.json` job file into `~/.draft/background/pending/`. The daemon scans this directory every 5 seconds. For each job it runs `synthesize.sh`, which calls Claude to read the session transcript, extract team-relevant context changes, and write a proposal markdown file to the active workspace's `proposals/` directory. Failed jobs are moved to `failed/` for inspection.

**Integration pollers** — on a schedule, the daemon fires poller scripts for each connected integration:

| Integration | Interval | What it does |
|-------------|----------|-------------|
| Granola | 15 min | Fetches recent meeting notes; creates synthesis jobs |
| Slack | 4 hours | Batch-processes buffered Slack messages into proposals |
| GitHub | 1 hour | Fetches recent activity on watched repos; creates synthesis jobs |

A separate Slack manager runs every 60 seconds to ensure the long-running `slack-capture` process stays alive.

All poller output is written to `~/.draft/background/logs/daemon.log`.

---

## The synthesis pipeline

Synthesis is what turns raw inputs (session transcripts, meeting notes, Slack threads) into structured proposals the user reviews before anything touches their workspace.

```
Session ends / integration polls
        │
        ▼
Job file written to pending/
        │
        ▼  (daemon picks up on next tick)
synthesize.sh routes to the right adapter
        │
        ▼
Adapter calls Claude → extracts context changes
        │
        ▼
Proposal written to workspace/proposals/
        │
        ▼  (user accepts in desktop app or CLI)
Context files updated in workspace/context/
```

The synthesis step only runs for clean session exits (`reason: prompt_input_exit`). Crash or force-kill exits are skipped because the transcript may be incomplete.

---

## The shared plugin directory

`~/.draft/shared/` is the single source of truth for all plugin assets — skills, agents, and hook scripts. When `draft add <tool>` runs, it doesn't copy files into each tool's config directory; it creates symlinks into `shared/`. When `draft update` runs, it only writes to `shared/`, and all tools pick up the changes immediately without re-running setup.

---

## Team collaboration

When collaboration is configured, context syncs through a GitHub repo the team owns. Draft doesn't act as an intermediary — it uses the local `gh` CLI.

**Publish:** accepted proposals in `workspace/accepted/` are committed to the shared repo via `commit-to-team-context.sh`.

**Load:** at every session start, `load-team.sh` does a shallow clone of the team repo, reads the change log since the last-loaded cursor, and applies teammates' accepted updates to the local workspace. A notification is written for `inject-context.sh` to surface at session start.

---

## See also

- [How context injection works](./how-context-injection-works.md)
- [Agent plugins](./agent-plugins.md)
- [CLI reference](./cli.md)
