---
name: draft-update
description: >
  Check for and apply Draft plugin updates. Detects when a newer version is
  available on GitHub and guides the user through reinstalling the plugin to
  get the latest skills and fixes.
---

# /draft:update

Check for and apply Draft plugin updates.

## When to invoke
- User runs `/draft:update`
- User asks to update Draft, check for updates, or upgrade the plugin
- Session context includes a `## Draft Update Available` block (mention it naturally and offer to run this skill)

## What to do

### Step 1 — Check current state

Run these two commands:
```
cat ~/.draft/version
cat ~/.draft/last-update-check
```

If `last-update-check` is missing or stale, force a fresh check:
```
bash ~/.draft/scripts/draft-update-check.sh --force
cat ~/.draft/last-update-check
```

### Step 2 — Report to user and confirm

- If `UP_TO_DATE`: tell the user they're already on the latest version. Done.
- If `UPGRADE_AVAILABLE <old> <new>`: tell the user v`<new>` is available (they're on v`<old>`).

**Use the `AskUserQuestion` tool to confirm before proceeding.** Ask:

> "Draft v`<new>` is available (you're on v`<old>`). Update now?"

Choices: `["Yes, update now", "No, skip for now"]`

Only proceed if the user selects "Yes, update now". If they decline, acknowledge and stop.

### Step 3 — Run the update script

```
bash ~/.draft/scripts/draft-update.sh
```

### Step 3.5 — Workspace migration (v1.5 only)

**Only run this step if upgrading FROM a version below 1.5.0.**

The v1.5.0 release restructures the personal layer of the workspace. Old paths must be moved to new paths so session context injection works correctly.

**Check for old paths:**
- `~/.draft/workspace/context/user/index.md`
- `~/.draft/workspace/memory/memory.md`

If either exists:

1. Explain to the user what is changing:
   > "v1.5 moves your personal context to a new location (`personal/`) to separate it from shared team context. I'll migrate your files now."

2. Use the `AskUserQuestion` tool to confirm:
   > "Migrate your workspace to the v1.5 layout now? Your data won't be lost."

   Choices: `["Yes, migrate", "No, I'll do it manually"]`

3. On confirmation, use your file tools to:
   - Create `~/.draft/workspace/personal/user/` directory (write a placeholder if needed)
   - Move `context/user/index.md` → `personal/user/index.md`
   - Scan `~/.draft/workspace/context/user/` for any other files the user may have added — move those too
   - Create `~/.draft/workspace/personal/` if not exists
   - Move `memory/memory.md` → `personal/memory.md`
   - Scan `~/.draft/workspace/memory/` for any other files — move those too
   - Create `~/.draft/workspace/config/` directory if not exists
   - Create blank `~/.draft/workspace/config/collaboration.json` and `~/.draft/workspace/config/local.json` if they don't exist (do not overwrite if already present)
   - Remove now-empty `context/user/` and `memory/` directories if they are empty

4. Report exactly what was moved. If anything looked unexpected (extra files, conflicts), surface it to the user.

5. If the user declines migration, warn them:
   > "Skipped. Note: without migration, personal context (memory, working style) won't load in sessions until you move the files manually."

### Step 4 — Summarize what changed

Fetch the CHANGELOG and show the user what's new in the version they just installed:
```
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft-cli-plugin/main/CHANGELOG.md
```

Find the entries between their old and new version and give a brief plain-English summary.

### Step 5 — Remind the user to restart

Tell them to restart their session (close and reopen Claude Code / Codex / Cursor) for all changes to take effect.

---

## Notes
- **Always use `AskUserQuestion` to confirm** before running the update and before running workspace migration — never run either automatically
- **Workspace migration is intentional for v1.5**: the update script is normally workspace-safe, but v1.5 is a one-time exception to move personal files to the new `personal/` layer. This is gated strictly to upgrades crossing the 1.5.0 boundary.
- Claude Code plugin agent/skill files are managed by Anthropic's plugin system and update separately from this script
