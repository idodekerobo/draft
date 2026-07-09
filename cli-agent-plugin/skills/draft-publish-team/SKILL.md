---
name: draft-publish-team
description: >
  Publish accepted context proposals, context updates, team skills, and team
  MCP definitions in one canonical repository transaction.
---

# /draft:publish-team — Publish Team Context and Assets

Do not clone the repository, apply proposals, copy workspace files, stage Git
paths, or update publish timestamps directly. The CLI owns the transaction and
updates local baselines only after a successful push.

### Step 1 — Discover what changed

```bash
draft publish --list-changed --json
```

This is a local, read-only `history.db` lookup — no network call, no clone.
It returns `{ ok, profile, paths }`, where `paths` are the actual unpublished
context file paths.

- If `paths` is empty, report that there is nothing to publish and stop. Do
  not run `draft publish` at all.
- If `paths` has exactly one entry, skip straight to Step 3 as a full publish
  (no need to ask — there's only one thing it could mean).

### Step 2 — Ask, if more than one file changed

If `paths` has more than one entry, use the **AskUserQuestion** tool (same
convention as `draft-profiles/SKILL.md`) to ask:

> `You have unpublished changes in: <list the paths from Step 1>. Publish everything, or just specific files?`

Offer "Everything" and "Specific files" as options. If the user picks
specific files, have them choose from the exact `paths` list returned in
Step 1 — never invent or guess a file name.

### Step 3 — Publish

- Everything → `draft publish --json` (no flags).
- Specific files → `draft publish --json --path <x> --path <y>` (repeat
  `--path` once per chosen file, using only paths from Step 1's output).

**A scoped publish (one or more `--path` flags) never clears the accepted
proposals queue** — there's no per-proposal-to-per-file mapping today, so a
single-file publish leaves `accepted/` untouched even if proposals exist. Only
a full publish (no `--path`) clears accepted proposals.

Interpret the JSON result:

- If `ok` is true and `published` is true, summarize what was published
  (scoped: the specific file(s); full: team context and assets, plus any
  proposals cleared).
- If `ok` is true and `published` is false, report that there was nothing to
  publish.
- If authentication, validation, commit, or push fails, surface the error. Do
  not delete accepted proposals or claim the workspace was published.

Secrets and machine-local configuration are never published.
