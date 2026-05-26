---
name: draft-profiles
description: >
  Profile lifecycle management for Draft. List, create, rename, and delete named workspaces.
  Each profile is an independent context directory at ~/.draft/workspaces/<name>/.
  The personal layer (~/.draft/personal/) is global and shared across all profiles.
---

# /draft:profiles — Profile Lifecycle Management

## Overview

Manages named Draft profiles. Each profile is an independent workspace at
`~/.draft/workspaces/<name>/` with its own `context/`, `config/`, and `docs/`.
The global personal layer (`~/.draft/personal/`) is shared across all profiles — never
inside a profile directory.

```
/draft:profiles                      List all profiles (active marked with *)
/draft:profiles create <name>        Create a new profile from the workspace template
/draft:profiles delete <name>        Delete a profile (confirmation required — hard delete, no trash)
/draft:profiles rename <old> <new>   Rename a profile
```

---

## Command: list (no args)

```bash
python3 -c "
from pathlib import Path
draft_global = Path.home() / '.draft'
workspaces = draft_global / 'workspaces'
active_file = draft_global / 'active-profile'

active = active_file.read_text().strip() if active_file.exists() else ''

if not workspaces.exists() or not any(p for p in workspaces.iterdir() if p.is_dir()):
    print('No profiles found. Run /draft:profiles create <name> to create one.')
else:
    print('Your Draft profiles:')
    for p in sorted(workspaces.iterdir()):
        if p.is_dir():
            marker = '* ' if p.name == active else '  '
            suffix = '  (active)' if p.name == active else ''
            print(f'  {marker}{p.name}{suffix}')
    print()
    print('Run /draft:switch <name> to activate a profile.')
"
```

Output the result directly.

---

## Command: create <name>

### Step 1 — Slugify the name

Apply slug transformation rules:
- Lowercase → replace spaces and underscores with hyphens → strip non-alphanumeric/hyphen chars → truncate to 40 characters

```bash
python3 -c "
import re, sys
name = sys.argv[1]
slug = name.lower()
slug = re.sub(r'[\s_]+', '-', slug)
slug = re.sub(r'[^a-z0-9-]', '', slug)
slug = slug[:40].strip('-')
print(slug if slug else 'INVALID')
" -- "<raw-name>"
```

If result is `INVALID` or empty, respond:
> `Invalid profile name: '<name>'. Use letters, numbers, and hyphens.`
Stop here.

### Step 2 — Check for collision

```bash
python3 -c "
from pathlib import Path
target = Path.home() / '.draft' / 'workspaces' / '<slug>'
print('EXISTS' if target.exists() else 'OK')
"
```

If `EXISTS`, respond:
> `Profile '<slug>' already exists.`
Stop here.

### Step 3 — Scaffold the profile directory

Create the minimal structure. Do NOT create `personal/` — that's global at `~/.draft/personal/`.

```bash
python3 - <<'PYEOF'
from pathlib import Path
import sys

name = "<slug>"
base = Path.home() / ".draft" / "workspaces" / name

# Create directory structure — NO personal/ (that's global at ~/.draft/personal/)
dirs = [
    base / "context" / "company" / "log",
    base / "context" / "product" / "log",
    base / "context" / "team" / "log",
    base / "context" / "priorities" / "log",
    base / "context" / "decisions",
    base / "docs",
    base / "config",
]

for d in dirs:
    d.mkdir(parents=True, exist_ok=True)

# Stub index files
for dim in ["company", "product", "team", "priorities"]:
    idx = base / "context" / dim / "index.md"
    idx.write_text(f"---\nname: {dim}\ndescription: >\n  No information recorded yet.\nlast_updated: \"\"\nsource: \"\"\n---\n")

# tensions.md
(base / "context" / "tensions.md").write_text(
    "# Tensions\n\nActive contradictions and inconsistencies noticed across context dimensions.\n"
)

# docs/.gitkeep
(base / "docs" / ".gitkeep").touch()

print(f"Profile '{name}' created at ~/.draft/workspaces/{name}/")
PYEOF
```

### Step 4 — Confirm

Respond:
> `Profile '<name>' created. Run /draft:switch <name> to activate it, then /draft:setup to initialize shared context.`

---

## Command: delete <name>

### Step 1 — Validate

```bash
python3 -c "
from pathlib import Path
draft_global = Path.home() / '.draft'
target = draft_global / 'workspaces' / '<name>'
active_file = draft_global / 'active-profile'
active = active_file.read_text().strip() if active_file.exists() else ''

if not target.exists():
    print('NOT_FOUND')
elif '<name>' == active:
    print('IS_ACTIVE')
else:
    print('OK')
"
```

- **`NOT_FOUND`**: respond `Profile '<name>' not found.` Stop.
- **`IS_ACTIVE`**: respond `Switch to another profile first before deleting this one.` Stop.

### Step 2 — Confirm with the user

Use the **AskUserQuestion** tool to ask:
> `This will permanently delete the profile '<name>' and all its context files. There is no undo. Type 'yes' to confirm.`

If the user does not clearly confirm with "yes", abort:
> `Deletion cancelled.`

### Step 3 — Delete

```bash
rm -rf ~/.draft/workspaces/<name>
```

Confirm:
> `Profile '<name>' deleted.`

---

## Command: rename <old> <new>

### Step 1 — Validate

```bash
python3 -c "
from pathlib import Path
workspaces = Path.home() / '.draft' / 'workspaces'
old_path = workspaces / '<old>'
new_path = workspaces / '<new>'

if not old_path.exists():
    print('OLD_NOT_FOUND')
elif new_path.exists():
    print('NEW_EXISTS')
else:
    print('OK')
"
```

- **`OLD_NOT_FOUND`**: respond `Profile '<old>' not found.` Stop.
- **`NEW_EXISTS`**: respond `Profile '<new>' already exists.` Stop.

### Step 2 — Rename the directory

```bash
mv ~/.draft/workspaces/<old> ~/.draft/workspaces/<new>
```

### Step 3 — Update active-profile if needed

If the renamed profile was the active one, update `~/.draft/active-profile`:

```bash
python3 -c "
from pathlib import Path
active_file = Path.home() / '.draft' / 'active-profile'
if active_file.exists() and active_file.read_text().strip() == '<old>':
    active_file.write_text('<new>\n')
    print('updated')
else:
    print('unchanged')
"
```

### Step 4 — Confirm

Respond:
> `Profile renamed: '<old>' → '<new>'.`

If the active profile was renamed, add:
> `Active profile updated. Takes effect next session — restart your session.`

---

## Notes

- `personal/` is NOT inside any profile. It lives at `~/.draft/personal/` and is global.
- `/draft:profiles create` scaffolds the directory only — it does NOT run the setup interview. After creating, run `/draft:switch <name>` then `/draft:setup` to populate context.
- Hard delete: no trash/recovery in v1. Always confirm before deleting.
- Profile names are automatically slugified on create (lowercase, hyphens only, max 40 chars).
