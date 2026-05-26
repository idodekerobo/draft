---
name: draft-compact
description: >
  Curator-triggered context compaction. Synthesizes accumulated appends in one or
  more context/*/index.md files into a clean, lean current-state document.
  Archives the pre-compact state to log/ before overwriting. Run when any index.md
  reads like a change log rather than a current-state document, or exceeds ~500 words.
---

# /draft:compact — Compact Context Dimensions

Fold accumulated appends into a clean, lean current-state `index.md`. Prevents token bloat in session injection.

**When to run:** When any `context/*/index.md` reads more like a change log than a current-state document, or when its word count is climbing past ~500 words.

**What it does:** Reads the current `index.md` + all `log/` entries for a dimension → synthesizes a clean current-state document → archives the old version to `log/` → overwrites. Direct write — no `proposals/` step needed since this is an explicit, intentional curator action.

---

## Step 1: Scan — measure all dimensions

Read all `context/*/index.md` files in `$DRAFT_WORKSPACE/context/`. For each, get the word count:

```bash
wc -w "$DRAFT_WORKSPACE/context/"*/index.md 2>/dev/null
```

Build an internal list of dimensions with their word counts and a flag for those above ~500 words.

---

## Step 2: Select which dimension(s) to compact

**Case A — called with a specific dimension** (e.g. `/draft:compact product`):
Skip the question. Proceed directly to Step 3 for that dimension only.

**Case B — called with no args** (just `/draft:compact`):
Always ask — never auto-select. Use `AskUserQuestion` to surface the scan results and prompt the user to choose:

Format the question like this — list all dimensions with their word counts, flag the ones above threshold, and offer "all" as an explicit option:

```
Which context dimension would you like to compact?

  product      (847 words)  ⚠️ recommended
  priorities   (312 words)
  company      (198 words)
  team          (95 words)

Reply with a dimension name, multiple names separated by spaces, or "all" to compact every dimension above 500 words.
```

Wait for the user's reply before proceeding.

If the user replies with a dimension name that doesn't exist in `context/`, tell them and re-prompt once.

---

## Step 3: Compact each selected dimension

Run this full sequence for each selected dimension, one at a time:

### 3a. Gather source material

Read:
- `$DRAFT_WORKSPACE/context/<dim>/index.md` — current content (may have accumulated appends)
- All files in `$DRAFT_WORKSPACE/context/<dim>/log/` — the full history of changes (read all, note total count)

Record the current word count before touching anything.

### 3b. Synthesize a clean current-state document

Using the current `index.md` content and all `log/` files as inputs, produce a clean replacement document.

**The compacted `index.md` must:**
- Reflect only the **current state** — what is true NOW, not a record of what changed when
- Preserve all currently-valid information (log/ entries win over older index content when they contradict)
- Discard information that has been superseded by newer log entries
- Use the same YAML frontmatter format as the original:
  ```yaml
  ---
  name: <dim>
  description: >
    [2–10 sentence summary of current state — updated to reflect compacted content]
  last_updated: <today's date YYYY-MM-DD>
  source: curator compaction | <original source>
  ---
  ```
- Have a clean body with no dated entries, no "as of [date]" accumulation, no "UPDATE:" or "APPEND:" prefixes — just current facts, clearly organized
- Be lean: aim to cut 40–60% of word count by removing redundancy and historical change notation

**The compacted body should read like:** "Here is what is true about [dimension] right now." Not "Here is everything that has happened over time."

### 3c. Show preview and require approval

Display the full compacted content with a before/after summary:

```
Compaction preview — context/<dim>/index.md
────────────────────────────────────────────
Before: [N] words
After:  [N] words

[full compacted content here]

────────────────────────────────────────────
Apply? [Y/n]
```

If `n`: skip this dimension — no changes made. Move to the next selected dimension if any remain.

### 3d. Apply (on Y)

Execute in this exact order — do not skip any step:

**1. Archive the pre-compact state** before touching the file:
```bash
ARCHIVE_TS=$(date -u +%Y%m%d%H%M%S)
cp "$DRAFT_WORKSPACE/context/<dim>/index.md" \
   "$DRAFT_WORKSPACE/context/<dim>/log/${ARCHIVE_TS}_pre-compact-archive.md"
```

**2. Write the compacted version** — use the Write tool to overwrite `context/<dim>/index.md` with the synthesized content.

**3. Write a compaction log entry** — create `$DRAFT_WORKSPACE/context/<dim>/log/${ARCHIVE_TS}_compaction.md`:

```markdown
---
date: <today's date YYYY-MM-DD>
type: compaction
curator: <gh username if available via `gh api user --jq .login`, else "curator">
before_words: <N>
after_words: <N>
log_entries_folded: <count of log/ files read, excluding the archive and this entry>
---

Compaction run by curator on <date>.
Pre-compact state archived to log/<ARCHIVE_TS>_pre-compact-archive.md.
<N> log entries folded into current-state index.md.
```

---

## Step 4: Confirm

Report for each compacted dimension:

```
✓ context/product/index.md   847 → 214 words (-75%)
  Archived: context/product/log/20260522123045_pre-compact-archive.md
  Log entry written.
```

If any dimensions were skipped (user said n): list them with "skipped — no changes made."

Then remind:
> "Run /draft:publish-team to push the compacted context to your team."

---

## Rules

- **Never compact without curator selection.** Always ask which dimension to compact — never auto-select or default to all.
- **Never compact without curator review.** Always show the full preview and require Y before writing.
- **Always archive before overwriting.** The pre-compact state must be recoverable via `log/`. No exceptions.
- **Always write a log entry.** Compaction without a log entry is invisible to CHANGES.jsonl and future surfaces.
- **Discard only what's superseded.** Compaction is synthesis, not deletion — if older content is still accurate, keep it.
- **Do not compact `tensions.md`.** Tensions are resolved manually by the curator, not synthesized away.
- **Prefer lean over comprehensive.** When in doubt, cut. The `log/` archive preserves full history.
- **This is a direct write.** Compact writes directly to `index.md` — it does not produce a `proposals/` file. This is intentional: compact is an explicit curator action, not automated synthesis. The daemon's overwrite guard (`commit-to-team-context.sh`) applies only to synthesis proposals, not to this skill.
