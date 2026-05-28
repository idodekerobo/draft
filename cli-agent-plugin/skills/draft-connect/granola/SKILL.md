# /draft:connect granola — Granola Integration Setup

Invoked by `draft-connect/SKILL.md` when the user runs `/draft:connect granola`.
Not a registered skill — executed by the parent skill via Read.

Connect Granola to the Draft daemon so meeting transcripts are automatically
synthesized into team context. Two connection methods:

- **MCP** (recommended) — Claude Code calls Granola directly via OAuth during synthesis.
  No token needed. Requires authenticating once in a new session after setup.
- **API** — Daemon fetches transcripts via REST. Requires a personal access token.

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
ls ~/.draft/background/integrations/granola/granola-poller.sh 2>/dev/null && echo "installed" || echo "not installed"
```

If not installed: "The Draft daemon isn't installed. Run `bash <plugin_root>/background/install.sh` first, then re-run `/draft:connect granola`." Hard stop.

---

## Step 1: Check current Granola state

```bash
python3 -c "
import json, subprocess
from pathlib import Path

# Check MCP via claude mcp list (most reliable)
mcp_connected = False
try:
    result = subprocess.run(['claude', 'mcp', 'list'], capture_output=True, text=True)
    mcp_connected = 'granola' in result.stdout.lower()
except: pass

# Fallback: check settings.json
if not mcp_connected:
    settings = Path.home() / '.claude' / 'settings.json'
    if settings.exists():
        try:
            d = json.loads(settings.read_text())
            mcp_connected = any('granola' in k.lower() for k in d.get('mcpServers', {}).keys())
        except: pass

ws_file = Path.home() / '.draft' / 'active-profile'
profile = ws_file.read_text().strip() if ws_file.exists() else 'default'
secrets = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'secrets.json'
api_token = ''
saved_mode = ''
if secrets.exists():
    try:
        d = json.loads(secrets.read_text())
        api_token = d.get('granola_api_token', '')
        saved_mode = d.get('granola_mode', '')
    except: pass

print(f'mcp_connected:{mcp_connected}')
print(f'api_token_set:{bool(api_token)}')
print(f'saved_mode:{saved_mode}')
"
```

If already configured, show state and use **AskUserQuestion**:
> "Granola is already connected via [mcp / api]. Reconfigure it?"

- No → print current status and stop.
- Yes → continue to Step 2.

---

## Step 2: Choose connection method

Use the **AskUserQuestion** tool:
> "How would you like to connect Granola?
>
> (1) MCP server — Claude Code calls Granola directly during synthesis (recommended)
>     Requires: one-time browser OAuth after setup. No token needed.
>
> (2) REST API token — daemon fetches transcripts independently
>     Requires: a Granola personal access token"

- **(1)** → Step 3: MCP setup
- **(2)** → Step 4: API setup

---

## Step 3: MCP setup

Granola MCP uses HTTP transport + browser OAuth. The `claude mcp add` command registers
the server. Authentication happens in a new session via `/mcp` → Authenticate.
There is no API key for MCP — OAuth only.

### 3a. Register via claude CLI (global scope)

The Draft daemon runs synthesis sessions from outside any project directory, so the
Granola MCP must be registered globally (`--scope user`) to be available during synthesis.

```bash
claude mcp add --scope user granola --transport http https://mcp.granola.ai/mcp
```

Capture output. If non-zero exit:
- Print the error
- "Registration failed. Try running this manually in your terminal:
  `claude mcp add --scope user granola --transport http https://mcp.granola.ai/mcp`"
- Hard stop.

### 3b. Verify registration

```bash
claude mcp list 2>/dev/null | grep -i granola && echo "verified" || echo "not_found"
```

If not found: warn "MCP registered but not showing in `claude mcp list` — check manually." Continue.

### 3c. Save mode to secrets.json

```bash
python3 - <<'PYEOF'
import json
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

secrets['granola_mode'] = 'mcp'
secrets_path.write_text(json.dumps(secrets, indent=2) + '\n')
print('wrote:' + str(secrets_path))
PYEOF
```

### 3d. Confirm

Print:
```
✓ Granola MCP registered.

  Server: https://mcp.granola.ai/mcp (HTTP transport)
  Scope:  global (available in all sessions)
  Mode saved to: config/secrets.json

Two more steps required before synthesis will work:

  1. Start a new Claude Code session (MCP loads at session start).

  2. In the new session, run: /mcp
     Select "granola" → "Authenticate".
     A browser window will open — sign in to Granola to complete OAuth.

  3. After authenticating, the daemon picks up Granola on the next poll (~5 min).
     Test immediately with: `draft poll granola`

The OAuth token is stored by Claude Code and reused across sessions — one-time auth only.
```

Stop.

---

## Step 4: API setup

### 4a. Prompt for token

Use the **AskUserQuestion** tool:
> "Paste your Granola personal access token:
> (Granola app → Settings → API → Personal access token)"

- Store as `GRANOLA_TOKEN`
- If blank: "No token entered. Run `/draft:connect granola` when you have your token." Stop.

### 4b. Write token and mode to secrets.json

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

secrets['granola_api_token'] = '$GRANOLA_TOKEN'
secrets['granola_mode'] = 'api'

secrets_path.write_text(json.dumps(secrets, indent=2) + '\n')
os.chmod(str(secrets_path), 0o600)
print('wrote:' + str(secrets_path))
PYEOF
```

### 4c. Verify

```bash
python3 -c "
import json
from pathlib import Path
profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
secrets = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'secrets.json'
d = json.loads(secrets.read_text())
print(f'token_set:{bool(d.get(\"granola_api_token\"))} mode:{d.get(\"granola_mode\",\"\")}')
"
```

If token not set: "Failed to write token — check permissions on config/secrets.json." Hard stop.

### 4d. Confirm

Print:
```
✓ Granola connected via REST API.

  Token saved to config/secrets.json (chmod 600)
  Mode: api

The daemon will fetch Granola transcripts on the next poll cycle (~5 min).
Test now: `draft poll granola`

Restart the daemon to pick up the new mode:
  `draft stop && draft start`
```

Stop.
