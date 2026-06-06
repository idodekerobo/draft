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
