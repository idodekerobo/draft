---
name: draft-switch
description: >
  Activate a named Draft profile. Writes the profile name to ~/.draft/active-profile.
  Takes effect on the next session restart. With no args, shows the currently active profile.
---

# /draft:switch — Profile Activation

## Overview

`/draft:switch <name>` activates a named Draft profile. The change takes effect the next
time a session starts — the current session's `$DRAFT_WORKSPACE` does not change mid-session.
This is correct behavior: context is resolved once at session start, not dynamically.

`/draft:switch` with no arguments shows the currently active profile.

---

## Execution

### Step 0 — Extract the argument

Parse the profile name from the user's slash command invocation.

- The user typed something like `/draft:switch my-company` — extract `my-company` as the profile name.
- If no argument was provided (user just typed `/draft:switch`), skip to **Step 4 — No-arg**.

Store this as `PROFILE_NAME` for all subsequent steps. Do not proceed without it.

---

### Step 1 — List all available profiles

```bash
python3 -c "
from pathlib import Path
workspaces = Path.home() / '.draft' / 'workspaces'
active_file = Path.home() / '.draft' / 'active-profile'
active = active_file.read_text().strip() if active_file.exists() else ''

if not workspaces.exists():
    print('NO_PROFILES')
else:
    profiles = [p.name for p in sorted(workspaces.iterdir()) if p.is_dir()]
    if not profiles:
        print('NO_PROFILES')
    else:
        print('ACTIVE:' + active)
        for p in profiles:
            print('PROFILE:' + p)
"
```

Parse the output — collect `PROFILE:` lines into a list of available profiles and note the `ACTIVE:` value.

---

### Step 2 — Match against available profiles

With `PROFILE_NAME` from Step 0 and the profile list from Step 1:

**Case A — Exact match found:**
The profile list contains `PROFILE_NAME` exactly.
→ Go to **Step 3 — Switch**.

**Case B — No exact match, but close match exists:**
A profile name contains `PROFILE_NAME` as a substring, or `PROFILE_NAME` contains an existing profile name as a substring, or the names differ only by a few characters (e.g. `my-compny` vs `my-company`).
→ Go to **Step 2b — Ask about close match**.

**Case C — No match at all:**
No profile comes close to `PROFILE_NAME`.
→ Go to **Step 2c — Ask about creating a new profile**.

**Case D — NO_PROFILES:**
No profiles exist yet.
→ Go to **Step 2d — No profiles exist**.

---

### Step 2b — Ask about close match

Use the **AskUserQuestion** tool to ask:

> `No profile named '<PROFILE_NAME>' found — did you mean '<CLOSE_MATCH>'?`

- If **yes**: set `PROFILE_NAME = CLOSE_MATCH` and go to **Step 3 — Switch**.
- If **no**: use the **AskUserQuestion** tool to ask if they'd like to create a new profile named `<PROFILE_NAME>` instead:
  > `Would you like to create a new profile named '<PROFILE_NAME>'?`
  - If **yes**: run `/draft:profiles create <PROFILE_NAME>` and confirm once created.
  - If **no**: respond `Ok — no changes made. Run /draft:profiles to see all available profiles.` and stop.

---

### Step 2c — Ask about creating a new profile

Use the **AskUserQuestion** tool to ask:

> `No profile named '<PROFILE_NAME>' found. Would you like to create a new profile with that name?`

- If **yes**: run `/draft:profiles create <PROFILE_NAME>` inline (execute the create steps from that skill), then confirm with:
  > `Profile '<PROFILE_NAME>' created and activated. Restart your session to load this context.`
  Then write `<PROFILE_NAME>` to `~/.draft/active-profile` and stop.
- If **no**: respond `Ok — no changes made. Run /draft:profiles to see all available profiles.` and stop.

---

### Step 2d — No profiles exist

Respond:
> `No profiles found yet. Run /draft:profiles create <name> to create your first profile.`

Stop here.

---

### Step 3 — Switch (exact match confirmed)

Write the profile name to `~/.draft/active-profile`:

```bash
echo "<PROFILE_NAME>" > ~/.draft/active-profile
```

If the write fails (non-zero exit), respond:
> `[Draft] Failed to write active-profile. Check file permissions for ~/.draft/`

On success, respond:
> `[Draft] Switched to profile: <PROFILE_NAME>. Restart your session to load this context.`

---

### Step 4 — No-arg: show current profile

```bash
python3 -c "
from pathlib import Path
active = Path.home() / '.draft' / 'active-profile'
workspaces = Path.home() / '.draft' / 'workspaces'

if active.exists():
    name = active.read_text().strip()
    profiles = [p.name for p in sorted(workspaces.iterdir()) if p.is_dir()] if workspaces.exists() else []
    others = [p for p in profiles if p != name]
    print(f'Active profile: {name}')
    if others:
        print(f'Other profiles: {\", \".join(others)}')
    print('Run /draft:profiles to manage profiles.')
else:
    print('No active profile set. Run /draft:profiles to create one.')
"
```

Output the result directly — do not add commentary.

---

## Error handling

| Scenario | Response |
|----------|----------|
| Exact profile found | Switch and confirm — restart required |
| Close match found | AskUserQuestion — offer the close match |
| No match found | AskUserQuestion — offer to create a new profile |
| No profiles exist at all | Prompt to run `/draft:profiles create <name>` |
| `~/.draft/active-profile` write fails | `[Draft] Failed to write active-profile. Check file permissions for ~/.draft/` |
| No argument given | Show active profile + other available profiles |

---

## Notes

- `/draft:switch` only activates profiles — it does not create them directly. If a user confirms they want to create a new profile, execute the create steps from `/draft:profiles create`.
- The change takes effect at the start of the **next session**. The current session's `$DRAFT_WORKSPACE` does not change mid-session.
- To list all available profiles: run `/draft:profiles`
