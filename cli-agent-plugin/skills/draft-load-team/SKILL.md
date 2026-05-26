---
name: draft-load-team
description: >
  Pulls the latest team context from the shared GitHub repo directly into the
  local context/ directory. Reads CHANGES.jsonl, filters to entries since last
  load, writes updated context files. Personal layer is never touched.
---

# /draft:load-team — Load Team Context

Pull the latest shared context from the team repo into your local workspace.

After loading, your `context/` IS the shared brain — ready for the next session.
Your `personal/` layer is never touched by this command.

---

## Step 1: Read config and verify auth

Read `$DRAFT_WORKSPACE/config/collaboration.json` using `json.loads()`.
Read `$DRAFT_WORKSPACE/config/local.json` using `json.loads()`.

If `config/collaboration.json` is missing or `mode` is not `github`:
```
Error: Collaboration not configured. Run /draft:setup-collab first.
```
Hard stop.

Verify gh auth:
```bash
gh auth status
```

If fails:
```
GitHub auth expired. Run `gh auth login --web` then re-run /load-team.
```
Hard stop.

---

## Step 1.5: Check for unpublished local changes

Before loading from the shared repo, check if the local workspace has changes that haven't been published yet. Loading will overwrite local context — silent overwrite of unpublished work is a data loss risk.

**Check:** Scan `$DRAFT_WORKSPACE/context/*/log/` for log files with a modification time newer than `config/local.json:last_published`.
- If `last_published` is `null`: any log entries present = unpublished changes.
- If no log entries exist: no local changes to protect — proceed to Step 2.

**If unpublished changes are found:** identify which dimensions have changes (which `context/<dim>/log/` dirs have new entries) and surface this to the user:

```
⚠️  Unpublished local changes detected in: product, priorities

Loading will overwrite these with the shared team context.
Your options:
  [P] Publish first  — run /draft:publish-team, then reload
  [C] Continue       — overwrite local changes and load anyway
  [A] Abort          — exit without loading

Choice [P/C/A]:
```

- `P` → hard stop: "Run /draft:publish-team to push your changes first, then re-run /draft:load-team."
- `C` → proceed to Step 2 (user explicitly chose to overwrite)
- `A` → hard stop: "Load cancelled. Your local context is unchanged."

**If no unpublished changes:** proceed to Step 2 silently — no prompt needed.

---

## Step 2: Clone and read CHANGES

```bash
TMPDIR=$(mktemp -d /tmp/draft-load-XXXX)
git clone [team_repo_url] "$TMPDIR"
```

If git clone fails:
```bash
rm -rf "$TMPDIR"
```
```
Couldn't reach [team_repo_url]. Check your network and repo access.
```
Exit 1. DO NOT update `config/local.json`.

Set the subdir prefix based on `team_repo_subdir`:
```bash
# team_repo_subdir = root → SUBDIR_PATH="$TMPDIR"
# team_repo_subdir = .draft → SUBDIR_PATH="$TMPDIR/.draft"
# team_repo_subdir = [custom] → SUBDIR_PATH="$TMPDIR/[custom]"
```

Check for CHANGES.jsonl:
```bash
CHANGES_FILE="$SUBDIR_PATH/CHANGES.jsonl"
```

If `CHANGES_FILE` does not exist:
```bash
rm -rf "$TMPDIR"
```
```
No change history in the team repo yet. Ask your curator to run /publish-team first.
```
Exit 0.

---

## Step 3: Merge shared config

Read `$SUBDIR_PATH/config/collaboration.json` using `json.loads()`.

Merge into local `$DRAFT_WORKSPACE/config/collaboration.json` using the following logic — repo wins for all fields, **except `teammates` which is a union merge** (deduplicated, repo order preserved):

```python
import json
from pathlib import Path

local_path = Path(ACTIVE_WORKSPACE) / 'config' / 'collaboration.json'
repo_path = Path(SUBDIR_PATH) / 'config' / 'collaboration.json'

local_config = json.loads(local_path.read_text())
repo_config = json.loads(repo_path.read_text())

# Merge: repo wins for all fields, but teammates is a union
merged = {**repo_config}
local_teammates = local_config.get('teammates', [])
repo_teammates = repo_config.get('teammates', [])
merged['teammates'] = list(dict.fromkeys(repo_teammates + local_teammates))  # deduped, order preserved

local_path.write_text(json.dumps(merged, indent=2))
```

**Never touch `config/local.json`** — machine state is always local-only.

This is how new teammates added by the curator propagate automatically to all existing teammates. The union merge ensures a teammate's own handle is never removed from their local copy.

---

## Step 4: Filter and deduplicate CHANGES

Read all entries from `CHANGES.jsonl` (one JSON object per line).

Filter: keep entries where `ts` > `config/local.json:last_loaded`
- If `last_loaded` is `null` (from `local.json`): keep ALL entries (initial load).

Deduplicate: build a set of `id` values already seen; skip any duplicate IDs.

If no entries remain after filtering:
```bash
rm -rf "$TMPDIR"
```
```
Team context is up to date (last loaded: [last_loaded]).
```
Exit 0.

---

## Step 5: Write context files

For each unique `file` path in the filtered entries:

```bash
SOURCE="$SUBDIR_PATH/[file]"           # e.g. $SUBDIR_PATH/context/product/index.md
DEST="$DRAFT_WORKSPACE/[file]"         # e.g. ~/.draft/workspace/context/product/index.md
```

- If `SOURCE` exists: copy to `DEST` (overwrites local version of that dimension).
- If `SOURCE` doesn't exist: skip with warning: `"[file] listed in CHANGES but not found in repo — skipping."`

Only `context/` paths appear in CHANGES entries. `personal/` is never touched.

Create destination directory if needed:
```bash
mkdir -p "$(dirname "$DEST")"
```

Cleanup:
```bash
rm -rf "$TMPDIR"
```

---

## Step 6: Surface summary and update local state

Print:
```
Team context loaded: [N] changes since [last_loaded or "initial load"]

[For each filtered entry]:
  • [dimension]: [summary]
```

Update `$DRAFT_WORKSPACE/config/local.json`:
- Read the file with `json.loads()`, set `last_loaded` to the current ISO 8601 timestamp, write back with `json.dumps()`.
