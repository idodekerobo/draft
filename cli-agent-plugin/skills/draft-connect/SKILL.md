---
name: draft-connect
description: >
  Connect integrations to the Draft daemon. Guides the user through configuring
  Granola (MCP or API) and future integrations (Slack, GitHub). Run as
  /draft:connect to see all integrations, or /draft:connect <name> to configure
  a specific one. Each integration has its own sub-skill file in this directory.
---

# /draft:connect — Integration Hub

**Usage:**
- `/draft:connect` — show all integrations and current connection status
- `/draft:connect granola` — set up or reconfigure Granola
- `/draft:connect slack` — set up or reconfigure Slack *(coming Phase 3)*

---

## Step 1: Route by argument

Read the argument the user passed after `/draft:connect`.

**`/draft:connect granola`**
Read the file at `${CLAUDE_PLUGIN_ROOT}/skills/draft-connect/granola/SKILL.md`
and execute it from Step 0.

**`/draft:connect slack`**
Read the file at `${CLAUDE_PLUGIN_ROOT}/skills/draft-connect/slack/SKILL.md`
and execute it from Step 0.

**No argument — `/draft:connect`**
Continue to Step 2 (status display).

---

## Step 2: Status display

Show all integrations and their current connection state.

```bash
python3 -c "
import json, subprocess
from pathlib import Path

# ── Granola ──────────────────────────────────────────────────────────────────
mcp_connected = False
try:
    result = subprocess.run(['claude', 'mcp', 'list'], capture_output=True, text=True)
    mcp_connected = 'granola' in result.stdout.lower()
except: pass

if not mcp_connected:
    settings = Path.home() / '.claude' / 'settings.json'
    if settings.exists():
        try:
            d = json.loads(settings.read_text())
            mcp_connected = any('granola' in k.lower() for k in d.get('mcpServers', {}).keys())
        except: pass

ws_file = Path.home() / '.draft' / 'active-profile'
profile = ws_file.read_text().strip() if ws_file.exists() else 'default'
secrets_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'secrets.json'
api_token_set = False
saved_mode = ''
if secrets_path.exists():
    try:
        d = json.loads(secrets_path.read_text())
        api_token_set = bool(d.get('granola_api_token', ''))
        saved_mode = d.get('granola_mode', '')
    except: pass

if mcp_connected:
    granola_status = 'connected (MCP)'
elif api_token_set:
    granola_status = 'connected (API)'
else:
    granola_status = 'not configured'

print(f'granola:{granola_status}')
# ── Slack ─────────────────────────────────────────────────────────────────────
slack_status = 'not configured'
slack_mode = ''
if secrets_path.exists():
    try:
        d = json.loads(secrets_path.read_text())
        bot = d.get('slack_bot_token', '')
        app = d.get('slack_app_token', '')
        channels = d.get('slack_allowlist_channels', [])
        mode = d.get('slack_capture_mode', 'passive')
        if bot and app:
            slack_status = f"connected ({mode}, {len(channels)} channel{'s' if len(channels) != 1 else ''})"
            slack_mode = mode
    except:
        pass
print(f'slack:{slack_status}')
"
```

Print a status table using the output above:

```
Draft Integrations

  granola   [connected (MCP) | connected (API) | not configured]
  slack     [connected (passive, 2 channels) | not configured]

Run /draft:connect <name> to set up an integration.
```

Stop.
