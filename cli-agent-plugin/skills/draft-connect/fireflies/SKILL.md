---
name: draft-connect-fireflies
description: >
  Set up Fireflies integration for the Draft daemon. Guides the user through
  connecting Fireflies via MCP with a bearer-token API key. Writes
  config/secrets.json and config/integrations.json.
---

# /draft:connect fireflies — Fireflies Integration Setup

Invoked by `draft-connect/SKILL.md` when the user runs `/draft:connect fireflies`.
Not a registered skill — executed by the parent skill via Read.

Connect Fireflies to the Draft daemon so meeting transcripts are automatically
synthesized into team context. Single connection method:

- **MCP with API key** — Fireflies' remote MCP server requires a bearer-token
  API key for headless/unattended auth. Paste your key once; the token is
  baked into the MCP registration itself. No browser OAuth step needed.

---

## Step 0: Resolve workspace + check daemon

Resolve active workspace:

```bash
python3 -c "
from pathlib import Path
profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
ws = Path.home() / '.draft' / 'workspaces' / profile
print(str(ws))
"
```

Store as `ACTIVE_WORKSPACE`.

Confirm daemon is installed:

```bash
ls ~/.draft/background/integrations/fireflies/fireflies-poller.ts 2>/dev/null && echo "installed" || echo "not installed"
```

If not installed: "The Draft daemon isn't installed. Run `bash <plugin_root>/background/install.sh` first, then re-run `/draft:connect fireflies`." Hard stop.

---

## Step 1: Check current Fireflies state

```bash
python3 -c "
import json, subprocess
from pathlib import Path

# Check MCP via claude mcp list (most reliable)
mcp_connected = False
try:
    result = subprocess.run(['claude', 'mcp', 'list'], capture_output=True, text=True)
    mcp_connected = 'fireflies' in result.stdout.lower()
except: pass

ws_file = Path.home() / '.draft' / 'active-profile'
profile = ws_file.read_text().strip() if ws_file.exists() else 'default'
secrets = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'secrets.json'
api_token = ''
if secrets.exists():
    try:
        d = json.loads(secrets.read_text())
        api_token = d.get('fireflies_api_token', '')
    except: pass

print(f'mcp_connected:{mcp_connected}')
print(f'api_token_set:{bool(api_token)}')
"
```

If already configured, show state and use **AskUserQuestion**:
> "Fireflies is already connected. What do you want to do?
> (1) Reconfigure  (2) Disconnect  (3) Cancel"

- Reconfigure → write `connected: false` to integrations.json first (see helper below), then continue to Step 2.
- Disconnect → run **Disconnect flow** below, then stop.
- Cancel → print current status and stop.

**Disconnect flow:**
```bash
python3 - <<'PYEOF'
import json
from pathlib import Path

profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
workspace = Path.home() / '.draft' / 'workspaces' / profile

secrets_path = workspace / 'config' / 'secrets.json'
if secrets_path.exists():
    try:
        s = json.loads(secrets_path.read_text())
        s.pop('fireflies_api_token', None)
        secrets_path.write_text(json.dumps(s, indent=2) + '\n')
    except: pass

integrations_path = workspace / 'config' / 'integrations.json'
integrations = {}
if integrations_path.exists():
    try: integrations = json.loads(integrations_path.read_text())
    except: pass
integrations['fireflies'] = {'connected': False}
integrations_path.write_text(json.dumps(integrations, indent=2) + '\n')
print('fireflies:disconnected')
PYEOF
```

Also deregister the MCP server:
```bash
claude mcp remove fireflies 2>/dev/null || true
```

Print: `✓ Fireflies disconnected.`

---

## Step 2: Prompt for API key

Use the **AskUserQuestion** tool:
> "Paste your Fireflies API key:
> Open https://app.fireflies.ai/settings/developer-settings, then copy your API Key
> from the Developer Settings section."

- Store as `FIREFLIES_TOKEN`
- If blank: "No API key entered. Run `/draft:connect fireflies` when you have your key." Stop.

---

## Step 3: Register MCP

### 3a. Register via claude CLI (global scope, bearer token header)

The Draft daemon runs synthesis sessions from outside any project directory, so the
Fireflies MCP must be registered globally (`--scope user`) to be available during
synthesis. Unlike Granola's OAuth flow, the bearer token is passed directly as a header.

```bash
claude mcp add --scope user fireflies --transport http https://api.fireflies.ai/mcp -H "Authorization: Bearer $FIREFLIES_TOKEN"
```

Capture output. If non-zero exit:
- Print the error
- "Registration failed. Try running this manually in your terminal:
  `claude mcp add --scope user fireflies --transport http https://api.fireflies.ai/mcp -H \"Authorization: Bearer <your-key>\"`"
- Hard stop.

### 3b. Verify registration

```bash
claude mcp list 2>/dev/null | grep -i fireflies && echo "verified" || echo "not_found"
```

If not found: warn "MCP registered but not showing in `claude mcp list` — check manually." Continue.

### 3c. Write token to secrets.json

```bash
python3 - <<PYEOF
import json, os
from pathlib import Path

profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
secrets_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'secrets.json'
secrets_path.parent.mkdir(parents=True, exist_ok=True)

secrets = {}
if secrets_path.exists():
    try:
        secrets = json.loads(secrets_path.read_text())
    except: pass

secrets['fireflies_api_token'] = '$FIREFLIES_TOKEN'

secrets_path.write_text(json.dumps(secrets, indent=2) + '\n')
os.chmod(str(secrets_path), 0o600)
print('wrote:' + str(secrets_path))
PYEOF
```

### 3d. Write integrations.json

```bash
python3 - <<'PYEOF'
import json
from datetime import datetime
from pathlib import Path

profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
integrations_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'integrations.json'

integrations = {}
if integrations_path.exists():
    try: integrations = json.loads(integrations_path.read_text())
    except: pass

integrations['fireflies'] = {
    'connected': True,
    'last_connected': datetime.utcnow().isoformat() + 'Z',
}
integrations_path.write_text(json.dumps(integrations, indent=2) + '\n')
print('integrations.json updated')
PYEOF
```

### 3e. Confirm

Print:
```
✓ Fireflies connected.

  Server: https://api.fireflies.ai/mcp (HTTP transport, bearer token)
  Scope:  global (available in all sessions)
  Token saved to: config/secrets.json (chmod 600)

The daemon picks up Fireflies on the next poll (~5 min).
Test now: `draft poll fireflies`
```

Stop.
