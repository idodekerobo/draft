# How Proposals Work

When the daemon captures something from your sessions, meetings, Slack, or GitHub, it doesn't update your context files automatically. Instead, it stages a **proposal** — a structured suggestion that you review and explicitly accept or reject before anything changes.

This is intentional. The daemon reduces the work of keeping context current; it doesn't remove your judgment from the loop.

---

## What a proposal is

A proposal is a markdown file in `~/.draft/workspaces/<profile>/proposals/`. Each file contains:

- **Metadata** — which source created it (session, Granola, Slack, GitHub), when, and from which profile.
- **Context updates** — a structured list of changes: which context file to modify, what action to take, and the exact content to apply.
- **A synthesis preview** — a human-readable version of the same changes, formatted as they'll appear in your context file.

A proposal represents one or more updates to your workspace context. A session synthesis might produce one proposal touching `context/product/index.md`. A Granola meeting with a wide-ranging discussion might produce a proposal that touches both `context/product/index.md` and `context/priorities/index.md`.

---

## Where proposals come from

The daemon produces proposals from four sources:

**Claude Code / Codex / Cursor sessions**
When you close a session cleanly, the plugin queues a synthesis job. The daemon reads the full session transcript, extracts any team-relevant changes — decisions made, priorities shifted, things learned — and stages a proposal. Sessions that exit abnormally (crash, force-kill) are skipped; an incomplete transcript produces noise.

**Granola**
Polled every 15 minutes. New meeting notes are synthesized into proposals. If a meeting produced a product decision or changed a priority, it shows up here.

**Slack**
Polled every 4 hours. Tagged messages and monitored channels are batch-processed into proposals. Useful for capturing decisions made in threads that never made it into a meeting.

**GitHub**
Polled every hour. Activity on watched repos — PRs merged, issues closed, releases cut — is synthesized into proposed context updates when the activity is team-relevant.

All four sources go through the same synthesis pipeline: raw input → Claude extracts signal → structured proposal written to `proposals/`. The review experience is the same regardless of source.

---

## The three actions

Every context update in a proposal specifies one of three actions. These actions are enforced at both the synthesis prompt level and in the code that applies them — a synthesizer can't accidentally use the wrong one.

### `append` — the default

New information is always additive. The proposed content is appended to the end of the target context file. The existing content is never touched.

This is the only action synthesis sources (sessions, Granola, Slack, GitHub) are permitted to use for dimension files. It means context grows more accurate over time rather than being silently replaced.

**Example:** A session where you decided to sunset a feature produces a proposal that appends a `## Feature Sunset Decision (2026-06-06)` block to `context/product/index.md`. Your existing product context stays intact below it.

### `tension` — for contradictions

When new information directly contradicts something already in a context file, the synthesizer doesn't overwrite the existing content or append a conflicting version. Instead, it routes the contradiction to `context/tensions.md` with a structured entry:

```
### [short name for the contradiction]
- **Observed:** YYYY-MM-DD
- **Signal:** Session says "[new value]" but context/product says "[existing value]"
- **Status:** unresolved
- **Resolution:**
```

The contradiction stays visible until you resolve it manually. The daemon surfaces it; you decide which version is correct and update the relevant context file. The daemon never resolves contradictions unilaterally.

### `overwrite` — curator-triggered compaction only

`overwrite` replaces the entire content of a context file. It is **not available to synthesis sources**. If a session or integration proposal tries to use `overwrite`, the apply step fails hard.

The only authorized path to overwrite is `/draft:compact`, which is an explicit curator action: it reads the current file, synthesizes a clean consolidated version, archives the original to `context/<dimension>/log/` before overwriting, and requires you to review the result. The pre-compact state is always recoverable.

This restriction exists because unrestricted overwrite is how trust breaks down. A capital raise entered by the curator shouldn't be silently wiped the next time a session touches `priorities/index.md`. Append-only synthesis means the daemon can never destroy context that was deliberately set.

---

## Reviewing proposals

### Desktop app

The **Proposals** tab in the sidebar lists all pending proposals for the active profile, newest first. Select any proposal to see:

- **Diff view** (default) — shows your current context file as-is, with the proposed addition highlighted in green at the bottom. For `append` proposals, nothing in the existing file appears as removed — because nothing is being removed.
- **Raw view** — shows the full proposal file including YAML frontmatter. Use this to see exactly what the daemon captured, which source produced it, and the precise content that will be applied.

Accept or reject from the detail panel. The badge count in the sidebar reflects pending proposals for the active profile.

### CLI

```bash
draft proposals
```

Walks through pending proposals one at a time, oldest first. For each one it shows the source, dimension, action, and a preview of the proposed content.

Keys: `[a]` accept · `[r]` reject · `[s]` skip · `[q]` quit

Skipped proposals stay in the queue for the next review session.

---

## What happens when you accept

Accepting a proposal does two things in sequence:

1. **Applies the context updates to your local workspace.** Each update in the proposal is written to the target file according to its action — appended, tensioned, or (for compact-sourced proposals) overwritten. This happens immediately.
2. **Archives the proposal file.** The `.md` file is moved from `proposals/` to `accepted/`. It's kept as a record of what was applied and when.

Your context files are updated on disk as soon as you hit Accept. The next session you start will inject the updated context.

### Sharing accepted context with teammates

Accepting a proposal is a local operation. It updates your workspace, but doesn't automatically push to your team's shared repository. To share:

```bash
draft publish
```

This takes your accepted context updates, writes them to your team's shared GitHub repo, and records the change in `CHANGES.jsonl`. Teammates get the update the next time they start a session.

See [Setting up collaboration](./setting-up-collaboration.md) for how team publishing works.

---

## What happens when you reject

Rejecting a proposal applies nothing. The `.md` file is moved from `proposals/` to `rejected/` and your context files are unchanged.

Rejected proposals are kept rather than deleted, so you have a record of what the daemon suggested and chose not to apply.

---

## Why nothing auto-applies

The daemon is designed to reduce the effort of keeping context current — not to make changes without your knowledge. A few things follow from this:

**Synthesis quality isn't perfect.** Claude is good at extracting signal from transcripts and meeting notes, but it can't always distinguish between a decision that's team-relevant and one that's specific to a task. A session where you spent two hours debugging a third-party API might produce a noisy proposal. Reviewing proposals lets you catch those before they pollute shared context.

**Context is a trust artifact.** Teammates rely on shared context to start sessions grounded in accurate information. If context changes silently, teammates stop trusting it. Explicit approval is what makes the context layer trustworthy — every change is attributable, reviewable, and intentional.

**The curator model is deliberate.** One person controls what reaches the team. Teammates can read and rely on shared context without worrying that a colleague's session accidentally overwrote something important. This is a design choice, not a technical limitation.

---

## Proposal files on disk

Proposals are plain markdown files. You can open them in any editor.

```
~/.draft/workspaces/<profile>/
  proposals/           ← pending review
    20260606T040038Z-20637308.md
  accepted/            ← applied, archived
  rejected/            ← rejected, archived
```

Filename format: `<ISO timestamp>-<session short ID>.md`

A proposal file looks like this:

```
---
session_id: 20637308-6cde-48c2-8e26-4d01b631ac9d
input_source: session
synthesized_by: claude-code
timestamp: 2026-06-06T03:58:17Z
profile: draft-pm-agent
context_updates:
  - file: context/product/index.md
    action: append
    content: |
      ## Desktop App UI Architecture Decisions (2026-06-06)

      **Profile switcher location:** Moved from StatusBar to Sidebar footer...
---

## Synthesis preview

### context/product/index.md — append

**Desktop App UI Architecture Decisions (2026-06-06)**
...
```

The YAML frontmatter above the `---` contains the machine-readable instructions. The synthesis preview below is a human-readable version of the same content for quick review.

---

## Managing a large proposal backlog

If you haven't reviewed proposals in a while, the queue can grow. A few things to keep in mind when clearing a backlog:

- **Proposals were synthesized at different points in time.** A proposal from last week was written when your context files were in a different state. It may now be redundant or already captured by something you accepted since.
- **Accepting is additive.** Each accepted append adds to the bottom of the target context file. Accepting many proposals in sequence will grow your index files significantly.
- **Compact after a bulk accept.** Once you've cleared the queue, run `/draft:compact` on any dimension that's grown noisy. It synthesizes the accumulated appends into a clean current-state document and archives the history to `log/`.

---

## See also

- [How context injection works](./how-context-injection-works.md)
- [Architecture](./architecture.md)
- [Setting up collaboration](./setting-up-collaboration.md)
