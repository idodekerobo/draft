---
name: draft-import
description: >
  Import markdown content from a local directory or private GitHub repo into
  the active workspace. Analyzes source files, maps content to Draft dimensions,
  and stages the result as a proposal for review. Nothing is applied until the
  user accepts.
---

# /draft:import — Import Context from an Existing Source

Imports existing knowledge into your Draft workspace. Reads markdown files from the source, maps them to context dimensions using AI judgment, and stages a reviewable proposal — nothing is written to your workspace until you accept.

---

## Usage

```
/draft:import <source>
```

Where `<source>` is:
- A **local path**: `~/notes`, `/Users/you/obsidian-vault`, `./docs`
- A **GitHub repo**: `owner/repo` or `https://github.com/owner/repo`

---

## Step 1: Detect source type

If `<source>` starts with `~/`, `/`, or `./` → **local path**.
Otherwise → **GitHub repo**.

---

## Step 2: Fetch the content

### Local path

Expand `~` if present. Verify the directory exists — if not, tell the user and stop.

Use Glob to collect all `.md` files under the path (skip `.git/`, `node_modules/`). Read each file. If there are more than 50 files, ask the user to confirm before proceeding.

### GitHub repo

**Prerequisites — check both before proceeding:**

```bash
command -v gh >/dev/null 2>&1
```
If `gh` is not installed: "Install the GitHub CLI first: `brew install gh`" — stop.

```bash
gh auth status >/dev/null 2>&1
```
If not authenticated: "Run `gh auth login --web` then retry `/draft:import`." — stop.

**Clone to temp dir (separate-clone pattern):**

```bash
IMPORT_DIR=$(mktemp -d /tmp/draft-import-XXXXXX)
gh repo clone <repo> "$IMPORT_DIR" -- --depth 1 --quiet 2>&1
```

If the clone fails (repo not found, no access): tell the user and stop. The trap will clean up.

Collect `.md` files from `$IMPORT_DIR` (same as local). After reading all files, delete the temp dir:

```bash
rm -rf "$IMPORT_DIR"
```

---

## Step 3: Analyze and map

Read all collected files. For each file, use judgment to map it to a Draft dimension:

**Signals to use:**
- Parent directory name matches a known dimension (`product`, `company`, `team`, `priorities`, `decisions`, `research`, `backlog`) → strong match
- File name hints: `roadmap.md`, `strategy.md` → `product`; `team.md`, `members.md` → `team`; `okrs.md`, `goals.md` → `priorities`
- File content: look for context that matches a dimension's typical content

Group files by target dimension. Files that don't clearly map to any dimension → flag as "unmapped" (see Step 4).

**Existing workspace content:** Check which dimensions already have content in `$DRAFT_WORKSPACE/context/`. For those dimensions, note the overlap in the proposal — do not silently overwrite.

---

## Step 4: Write the proposal

Write a single proposal file to `$DRAFT_WORKSPACE/proposals/<timestamp>-import.md`.

**Timestamp format:** `YYYYMMDDTHHMMSSz` in UTC (e.g. `20260608T143000Z`).

**Proposal frontmatter:**

```yaml
---
input_source: import
import_from: <source>
timestamp: <UTC timestamp>
profile: <active profile name>
context_updates:
  - file: context/<dimension>/index.md
    action: append
    content: |
      <synthesized content — the key facts and context from the imported files, written
       in the same voice as Draft context descriptions: factual, concise, present-tense>
```

Use `action: append` for every entry — never overwrite.

For each unmapped file: add a note in the proposal **body** (below the frontmatter):
> "These files didn't map to a known dimension: `<filenames>`. Consider running `/draft:add-dimension <name>` to create a custom dimension, then re-import."

---

## Step 5: Confirm

Tell the user:

> "Import staged as a proposal.
>
> **Mapped:**
> - `product` ← 3 files (roadmap.md, strategy.md, vision.md)
> - `team` ← 1 file (team.md)
>
> **Unmapped:** notes.md, scratch.md
>
> Run `draft proposals` or `/draft:publish` to review and accept."

---

## Rules

- Always `action: append` — never overwrite existing context
- Delete temp dirs before ending the session (use the bash trap pattern)
- If source has no `.md` files: "No markdown files found in `<source>`." — stop
- One proposal file per import — do not write multiple proposals for one import
- Do not run a full interview or ask follow-up questions — the import is mechanical
