# What is Draft

> **Platform:** macOS on Apple Silicon only. Intel Mac and Windows support is not available yet.

Draft keeps your AI agent sessions grounded. It runs in the background, capturing context from your meetings, Slack, and coding sessions, then injects what your agent needs to know at the start of every session — automatically, with no copy-pasting.

Everything stays on your machine. Draft never routes your code, prompts, or context files through any server.

---

## The three components

Draft is three things that work together:

**Desktop app**
A native macOS app that runs as a tray icon. Browse your context files, review and accept or reject proposed context updates, manage profiles, and start or stop the background daemon. Install once; it launches at login.

**CLI (`draft`)**
A compiled binary installed to `/usr/local/bin/draft`. Every feature in the desktop app is also a CLI command: manage profiles, check daemon status, review proposals, publish team context, add integrations. Run `draft --help` to explore.

**Plugin**
Installed into Claude Code, Codex, Cursor, OpenClaw, or Hermes via `draft add <tool>`. At the start of every agent session, the plugin injects your current workspace context — company, product, team, priorities, decisions — directly into the agent's system prompt. At session end, it queues a job so the daemon can extract and propose updates. No copy-pasting. No re-explaining.

---

## How context flows

```
Inputs (Granola, Slack, GitHub)
        |
        v
Background daemon captures + synthesizes
        |
        v
Proposed updates land in your inbox (desktop app / CLI)
        |
        v  (you accept)
Workspace context: ~/.draft/workspaces/<profile>/context/
        |
        v
Plugin hook fires on every session start
        |
        v
Your context injected into the agent's system prompt
        |
        v
Agent starts every session fully briefed
```

---

## The background daemon

The daemon is a long-running process registered as a macOS LaunchAgent (`com.draft.daemon`). macOS starts it at login and restarts it automatically if it crashes.

It does three things:
- **Processes synthesis jobs** — when a Claude Code session ends, the plugin drops a job file locally. The daemon picks it up, uses Claude to extract any team-relevant updates from the session transcript, and stages them as proposals for your review.
- **Polls integrations** — Granola, Slack, and GitHub are polled on a schedule. New meeting notes, Slack threads, and GitHub activity are synthesized into proposed context updates.
- **Heartbeat** — writes a heartbeat file every few seconds so the desktop app can show live daemon status.

All processing happens locally. Integration pollers talk directly to those services' APIs using credentials stored on your machine.

See [Architecture](./architecture.md) for a detailed breakdown.

---

## Context injection

When you run `draft add claude-code`, Draft registers hooks directly into your local Claude Code installation (`~/.claude/settings.json`). These hooks fire at the start and end of every session:

- **Session start** — reads your active workspace context files and outputs them into the agent's system prompt. The agent sees your product context, priorities, and memory before responding to your first message.
- **Session end** — queues a synthesis job for the daemon.

This all runs locally. Draft does not intercept or proxy any model calls. It configures your tool once, then gets out of the way.

The same pattern applies to other platforms/agents — `draft add <tool>` wire equivalent hooks into each tool's own config.

See [How context injection works](./how-context-injection-works.md) for the full technical details.

---

## What stays on your machine

Everything.

| What | Where |
|------|-------|
| Workspace context files | `~/.draft/workspaces/<profile>/context/` |
| Proposals (pending review) | `~/.draft/workspaces/<profile>/proposals/` |
| Personal memory | `~/.draft/personal/memory.md` |
| Global config | `~/.draft/config.json` |
| Daemon binary + scripts | `~/.draft/background/` |
| Daemon logs | `~/.draft/background/logs/` |
| Skills and agents | `~/.draft/shared/` → symlinked into `~/.claude/` |
| Draft CLI binary | `~/.draft/bin/draft` → symlinked to `/usr/local/bin/draft` |

None of this is transmitted to Draft servers. Synthesis calls go through your own Claude subscription — Draft does not proxy them.

The only data that ever leaves your machine is optional, anonymous usage analytics — only if you opted in during onboarding, using an anonymous UUID, never your email or name. You can change this at any time in **Settings → Privacy**.

---

## Profiles

A profile is a named workspace — a directory at `~/.draft/workspaces/<name>/`. You can have multiple profiles for different clients, projects, or roles.

```bash
draft profiles             # list profiles
draft switch acme          # switch to the "acme" profile
```

The active profile determines which context gets injected at session start and which proposals inbox you're looking at. The desktop app shows and manages profiles in the status bar.

---

## Team collaboration

If you set up collaboration via `/draft:setup-collab`, Draft syncs context through a GitHub repository you control. At session start, Draft checks for updates from teammates and applies them locally. When you publish, your accepted context updates go to the shared repo.

Draft uses your local `gh` credentials to talk to GitHub directly — it does not act as an intermediary.

See [Setting up collaboration](./setting-up-collaboration.md).

---

## See also

- [How context injection works](./how-context-injection-works.md)
- [How proposals work](./proposals.md)
- [Architecture](./architecture.md)
- [Setting up collaboration](./setting-up-collaboration.md)
- [Privacy](./privacy.md)
