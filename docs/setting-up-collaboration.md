# Setting Up Collaboration

Draft can share a context layer across your whole team. Everyone's agent sessions start with the same product knowledge — kept fresh automatically as things change.

---

## How it works

Team context sharing uses a private GitHub repository as the sync layer. One person (the **curator**) owns the shared context and controls what gets published. **Teammates** connect to the same repo and receive fresh context automatically at session start — no manual steps required.

The mental model is simple: the curator reviews and publishes; teammates get fresh context for free.

---

## The curator/teammate model

The curator/teammate split is one workflow pattern, not a rigid system. In practice, anyone on the team can review proposals and publish context updates — there's no enforced role separation. The model just describes a common default: one person owns keeping the shared context current, and everyone else receives updates automatically.

If your team prefers a more distributed model — multiple people publishing from their own sessions — that works too. Each person runs `/draft:setup-collab`, connects to the same repo, and can publish their own accepted proposals.

**In the curator-led workflow:**

- One person reviews AI-generated proposals and accepts what's accurate
- They publish accepted updates to the shared repo with `draft publish`
- Everyone else gets fresh context at session start with no manual steps

**In a shared-ownership workflow:**

- Multiple people connect to the same repo
- Anyone can review their own proposals and publish
- Everyone pulls the latest on session start

Either way, nothing reaches the shared repo without a human explicitly accepting and publishing it. The daemon surfaces proposals; people decide what's true.

---

## Prerequisites

- `gh` CLI installed and authenticated (`gh auth status`)
- A GitHub account with access to create private repositories (or access to an existing one)

---

## Setup (curator)

Run this inside Claude Code or Codex:

```
/draft:setup-collab
```

The skill runs a short interview that:
1. Verifies your `gh` CLI auth
2. Creates a new private GitHub repo (or connects an existing one)
3. Chooses a subdirectory inside that repo for Draft to write to
4. Seeds the repo with your current context files
5. Writes `collaboration.json` to your workspace

At the end, you get a repo URL to share with teammates.

---

## Setup (teammate)

If your curator has already set up collaboration:

```
/draft:setup-collab
```

Choose "connecting to an existing repo" when prompted, then paste the URL your curator shared. Draft writes `collaboration.json` and pulls the curator's latest context automatically.

After that, context loads at every session start without any further action.

---

## Keeping context in sync

### For the curator

The daemon continuously synthesizes context proposals from connected integrations (Granola, Slack, GitHub) and session transcripts. These land in your **Proposals inbox** in the desktop app or via `draft proposals` in the CLI.

Your workflow:
1. Review proposals — accept what's accurate, reject what isn't
2. Run `draft publish` (or `/draft:publish-team`) to push accepted updates to the team repo
3. Teammates get the updates on their next session start

The daemon reduces how much you need to manually write. You're the editor, not the author.

### For teammates

Nothing required. Context is applied automatically at session start. If you want to pull fresh context mid-session:

```
/draft:load-team
```

The desktop app's Context tab also shows when team context was last loaded and has a one-click load button.

---

## Context integrity — what you can trust

A few design decisions protect the context layer from becoming noisy or untrustworthy:

**The background daemon never overwrites.** All synthesis is append-only. New information is additive; it can't silently replace context a curator has manually written. When the daemon finds a direct contradiction, it routes it to `tensions.md` for the curator to resolve — never resolves it unilaterally.

**The curator always approves.** Nothing reaches the team repo without a human accepting it. Auto-publish is never a default.

**Unpublished local changes are protected.** If you have accepted proposals that haven't been published yet, the auto-load at session start is skipped and you're warned. Your unpublished work is never silently overwritten by a team pull.

**Every change is audited.** The shared repo maintains a `CHANGES.jsonl` log. Every context update — what changed, when, from which source — is traceable.

---

## Integrations in a team context

Each integration (Granola, Slack, GitHub) is set up per person. This is intentional — each team member authenticates with their own credentials. A founder connecting their Granola sees their own meetings; an engineer connecting GitHub sees their own activity.

The daemon synthesizes from whoever has a given integration connected. If you want Granola meetings to flow into the team's shared context, the person running the meetings connects Granola. Their proposals go through the curator for review before reaching teammates.

Connect integrations from inside Claude Code:

```
/draft:connect
```

---

## Team skills & MCP servers

In addition to context files, Draft can sync **skills** (custom Claude Code/Codex prompt libraries) and **MCP servers** (tools) across your team via the same git repo.

### How team skills work

A **team skill** is `$DRAFT_WORKSPACE/skills/<name>/SKILL.md`. The active
profile's skills are symlinked into Claude Code (`~/.claude/skills/`) and Codex
(`~/.codex/skills/`). Switching profiles removes only symlinks owned by the old
profile and installs the new profile's set.

**Two flows for adding team skills:**

**Flow A — Promote an existing skill** (desktop): In Settings → Sync Skills, any synced skill has a "Share with team" button (visible when collaboration is configured). Clicking it moves the skill directory into the workspace and creates symlinks at the original paths so nothing breaks in the current session.

**Flow B — Write directly to workspace** (power users): Drop a `SKILL.md`-containing directory into `~/.draft/workspaces/<profile>/skills/` directly. The desktop watcher detects it and installs the symlinks immediately. The skill appears in Settings with a "Team" badge.

Anything under the profile's `skills/` directory is team-owned. A personal
skill with the same name is preserved and the team skill is reported as
conflicted. Any teammate may remove a team skill locally; publish that change
to propagate the removal.

### Publishing team skills

Team skills are included automatically when you run `draft publish`. Direct
workspace edits are unpublished team changes, so `draft load` will not
overwrite them. Publish them, move local-only assets out of the profile, or
explicitly run `draft load --discard-team-assets`.

### Team MCP servers (sharing tools, not secrets)

Team MCPs work similarly, with one important distinction: **API keys are never shared**. The workspace `config/mcp.json` stores only the server URL and header structure (using `value_env` references). Each teammate supplies their own credentials.

**Flow A — Promote an existing MCP** (desktop): In Settings → Sync MCP Servers, any synced MCP has a "Share with team" button. It writes the server's canonical config (without the literal token) to the workspace `config/mcp.json`.

**Flow B — Write to workspace** (power users): Edit
`$DRAFT_WORKSPACE/config/mcp.json` directly using the versioned workspace
manifest. Invalid or unsafe manifests are rejected before load or profile
activation mutates state.

### What teammates see after `load-team`

When a teammate runs `draft load`:

1. Team skills are copied to their workspace and symlinked to both agents automatically.
2. Team MCPs are copied to their workspace. If they already have the required API key(s) in their local `secrets.json`, the MCP is installed immediately. If not, a **credential prompt** appears in Settings → Sync MCP Servers.

Credentials live in the active profile's `config/secrets.json`, may differ
between profiles, and are never pushed. Once the final required value is saved,
the MCP installs into both agents. A personal MCP with the same name is
preserved and blocks only that team MCP.

### Profile switches and team skills

When you switch profiles (via the desktop or `draft switch`), Draft automatically:
1. Uninstalls team skills/MCPs from the old profile (removes symlinks)
2. Installs team skills/MCPs from the new profile (creates symlinks, prompts for missing credentials)

Missing credentials or name conflicts produce a partial activation rather than
rolling the profile back. Restart active Claude Code and Codex sessions after a
switch. Claude Code and Codex are the initial supported installation targets.

---

## Team load mode

By default, Draft auto-applies the latest shared context at session start ("shared repo always wins"). If you prefer to review team context changes before they apply, you can change this in **Settings → Session Context → Team Load Mode**.

| Mode | Behavior |
|------|---------|
| Auto (default) | Latest shared context is applied silently at session start |
| Review | Desktop app shows a diff of what changed; you confirm before applying |

Review mode is useful for teams that want visibility into what the curator published before it affects their sessions.

---

## See also

- [How context injection works](./how-context-injection-works.md)
- [Architecture](./architecture.md)
- [Privacy](./privacy.md)
