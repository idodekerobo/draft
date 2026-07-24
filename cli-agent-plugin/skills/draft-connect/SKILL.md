---
name: draft-connect
description: >
  Connect integrations to the Draft daemon. Guides the user through configuring
  Granola (MCP or API), Fireflies (MCP), Slack, and GitHub. Run as /draft:connect
  to see all integrations, or /draft:connect <name> to configure a specific one.
  Each integration has its own sub-skill file in this directory.
---

# /draft:connect — Integration Hub

**Usage:**
- `/draft:connect` — show all integrations and current connection status
- `/draft:connect granola` — set up or reconfigure Granola
- `/draft:connect fireflies` — set up or reconfigure Fireflies
- `/draft:connect slack` — set up or reconfigure Slack
- `/draft:connect github` — set up or reconfigure GitHub repo polling

---

## Step 1: Route by argument

Read the argument the user passed after `/draft:connect`.

**`/draft:connect granola`**
Read the file at `${CLAUDE_PLUGIN_ROOT}/skills/draft-connect/granola/SKILL.md`
and execute it from Step 0.

**`/draft:connect slack`**
Read the file at `${CLAUDE_PLUGIN_ROOT}/skills/draft-connect/slack/SKILL.md`
and execute it from Step 0.

**`/draft:connect github`**
Read the file at `${CLAUDE_PLUGIN_ROOT}/skills/draft-connect/github/SKILL.md`
and execute it from Step 0.

**`/draft:connect fireflies`**
Read the file at `${CLAUDE_PLUGIN_ROOT}/skills/draft-connect/fireflies/SKILL.md`
and execute it from Step 0.

**`/draft:connect granola disconnect`**, **`/draft:connect slack disconnect`**, **`/draft:connect github disconnect`**, **`/draft:connect fireflies disconnect`**
Read the corresponding sub-skill file and execute it from Step 1, passing `disconnect` as the action. The sub-skill's disconnect flow will run and stop.

**No argument — `/draft:connect`**
Continue to Step 2 (status display).

---

## Step 2: Status display

Show all integrations and their current connection state.

```bash
python3 -c "
import json
from pathlib import Path

ws_file = Path.home() / '.draft' / 'active-profile'
profile = ws_file.read_text().strip() if ws_file.exists() else 'default'
int_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'integrations.json'

integrations = {}
if int_path.exists():
    try: integrations = json.loads(int_path.read_text())
    except: pass

# ── Granola ───────────────────────────────────────────────────────────────────
g = integrations.get('granola', {})
if g.get('connected'):
    granola_status = f\"connected ({g.get('mode', 'unknown')})\"
else:
    granola_status = 'not configured'
print(f'granola:{granola_status}')

# ── Slack ─────────────────────────────────────────────────────────────────────
s = integrations.get('slack', {})
if s.get('connected'):
    ws = s.get('workspace', '')
    ch = s.get('channels', 0)
    slack_status = f\"connected ({ws}, {ch} channel{'s' if ch != 1 else ''})\"
else:
    slack_status = 'not configured'
print(f'slack:{slack_status}')

# ── GitHub ────────────────────────────────────────────────────────────────────
gh = integrations.get('github', {})
if gh.get('connected'):
    repos = gh.get('repos', [])
    github_status = f\"connected ({', '.join(repos)})\" if repos else 'connected'
else:
    github_status = 'not configured — run /draft:connect github'
print(f'github:{github_status}')

# ── Fireflies ─────────────────────────────────────────────────────────────────
ff = integrations.get('fireflies', {})
fireflies_status = 'connected' if ff.get('connected') else 'not configured'
print(f'fireflies:{fireflies_status}')
"
```

Print a status table using the output above:

```
Draft Integrations

  granola     [connected (MCP) | connected (API) | not configured]
  fireflies   [connected | not configured]
  slack       [connected (passive, 2 channels) | not configured]
  github      [connected (org/repo1, org/repo2) | not configured — run /draft:connect github]

Run /draft:connect <name> to set up an integration.
```

Stop.
