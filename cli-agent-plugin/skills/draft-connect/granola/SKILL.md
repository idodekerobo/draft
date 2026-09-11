---
name: draft-connect-granola
description: >
  Connect Granola through Draft Cloud's hosted pipeline. Guides the user
  through getting a Granola API key (personal or workspace) and running
  `draft integrations connect granola`. Requires a Granola Business or
  Enterprise plan and a Draft Cloud sign-in -- no local daemon config is
  written.
---

# /draft:connect granola — Granola Integration Setup

Invoked by `draft-connect/SKILL.md` when the user runs `/draft:connect granola`.
Not a registered skill — executed by the parent skill via Read.

Granola runs through Draft Cloud's hosted pipeline, not the local daemon:
Draft registers a webhook with Granola directly using your API key, so meeting
notes land in your workspace as they're generated. There's no MCP
registration, no local `secrets.json`/`integrations.json` entry, and no daemon
poll cycle to wait on — `draft integrations connect granola` does everything
in one call.

**Requires a Granola Business or Enterprise plan.** Granola only issues API
keys — and only allows webhooks — on those plans. If the workspace is on Free
or Pro, there is currently no way to connect Granola to Draft; the user needs
to upgrade first.

---

## Step 0: Confirm Draft Cloud sign-in

```bash
draft auth whoami --json >/dev/null 2>&1 && echo "signed_in" || echo "not_signed_in"
```

If `not_signed_in`: "You need to be signed in to Draft Cloud first. Run `draft auth login`, then re-run `/draft:connect granola`." Hard stop.

---

## Step 1: Check current Granola connections

```bash
draft integrations list --json 2>/dev/null
```

Look at the `connections` array for entries with `provider: "granola"`. There
can be up to two: one personal (has `is_mine`) and one workspace-wide.

If a connection already exists that this flow is about to touch (see Step 2
for which one that is), use **AskUserQuestion**:
> "Granola is already connected. What do you want to do?
> (1) Reconnect / rotate the key  (2) Disconnect  (3) Cancel"

- Reconnect → continue to Step 2 (reconnecting rotates the same connection —
  it never creates a duplicate row).
- Disconnect → run `draft integrations disconnect granola` (add
  `--workspace-key` to disconnect the workspace key instead of the personal
  one), then stop.
- Cancel → print current status and stop.

---

## Step 2: Choose key type

Use the **AskUserQuestion** tool:
> "What kind of Granola API key are you connecting?
>
> (1) Personal key — connects your own Granola notes. Anyone on the team can
>     do this with their own key; each person's notes stay private to them.
>
> (2) Workspace key — a key created by a *Granola* workspace admin (Settings
>     → Workspace → General → API access, on Granola's side — not a Draft
>     permission). Connects the workspace's shared/public notes for everyone."

Store the choice as `ACCOUNT_KIND` (`personal` or `workspace`).

---

## Step 3: Get a Granola API key

Tell the user:
> "Open the Granola desktop app → Settings → Connectors → API keys → Create
> new key. Choose the [Personal notes / Public notes] access scope to match
> what you picked above, then copy the generated key (starts with `grn_`)."

The CLI prompts for the key itself with a hidden, secure input — no need to
collect it here.

---

## Step 4: Connect

```bash
draft integrations connect granola
```

If `ACCOUNT_KIND` is `workspace`, add `--workspace-key`:

```bash
draft integrations connect granola --workspace-key
```

Both prompt for the API key on the terminal (hidden input) by default.

This single call does everything: Draft registers a webhook with Granola
using the key (no separate paste-into-Granola-UI step), stores the
credential, and backfills the last 7 days of existing notes.

If the command reports a duplicate-account error: "This Granola account is
already connected by another teammate. Each person connects their own key
once." Stop.

If it reports the workspace key is already connected, offer to reconnect
(rotates the same row) instead.

On success, tell the user:
```
✓ Granola connected.

Draft registered a webhook with Granola directly -- no further setup needed.
The last 7 days of notes were just backfilled; new notes arrive automatically
as Granola generates them.
```

Stop.
