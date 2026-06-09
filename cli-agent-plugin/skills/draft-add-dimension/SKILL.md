---
name: draft-add-dimension
description: >
  Scaffold a new context dimension. Creates context/<name>/index.md with
  standard frontmatter and context/<name>/log/. Works on brand-new dimensions
  and on existing folders that are missing an index.md (orphaned dimensions).
---

# /draft:add-dimension — Scaffold a Context Dimension

This command initializes a new context dimension so Draft can load it every session.

---

## Usage

```
/draft:add-dimension <name>
```

Where `<name>` is the dimension to create or scaffold (e.g. `research`, `decisions`, `legal`).

---

## Steps

### 1. Validate the name

The dimension name must be:
- Lowercase letters, numbers, hyphens only
- No spaces, slashes, or dots

If invalid, tell the user and stop.

### 2. Check current state

```bash
python3 -c "
import os
from pathlib import Path
ws = os.environ.get('DRAFT_WORKSPACE', '')
ctx = Path(ws) / 'context' / '<name>'
has_dir = ctx.is_dir()
has_index = (ctx / 'index.md').exists()
print('dir=' + str(has_dir))
print('index=' + str(has_index))
"
```

Three cases:
- **Folder + index.md exist** → "Dimension `<name>` is already initialized. Run `/draft:setup` re-run to refresh its content."  Stop.
- **Folder exists, no index.md** → scaffold mode: create index.md + log/ without touching existing files. Tell the user: "Scaffolding `<name>/` — folder already exists, just adding the missing index."
- **Folder does not exist** → create folder + index.md + log/

### 3. Write `context/<name>/index.md`

Use `@draft-learner` to write the file with this exact frontmatter:

```markdown
---
name: <name>
description: >
  No information recorded yet.
last_updated: ""
source: ""
---
```

### 4. Create `context/<name>/log/`

Create the log directory (empty). This is where the daemon writes change history entries.

```bash
mkdir -p "$DRAFT_WORKSPACE/context/<name>/log"
```

### 5. Confirm and optionally seed

Tell the user:

> "Dimension `<name>` is ready. Draft will load it every session starting now.
> Want to add some initial context? (Tell me what `<name>` tracks and I'll write it.)"

If yes: ask one question — "What does this dimension track? Give me a few sentences." — then call `@draft-learner` to update the `description` field in `context/<name>/index.md`.

If no: done.

---

## Rules

- Never overwrite an existing `index.md` — if one already exists, stop with an informative message
- `log/` creation is always safe (idempotent)
- One question max when seeding initial content — do not run a full interview
