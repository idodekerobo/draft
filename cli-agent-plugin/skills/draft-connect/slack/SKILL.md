---
name: draft-connect-slack
description: >
  Set up Slack integration for the Draft daemon. Guides the user through creating
  a Slack app, configuring tokens, selecting channels, and inferring team member
  roles via LLM. Writes config/secrets.json and config/slack-roles.json.
---

# /draft:connect slack — Slack Integration Setup

**What this unlocks:** The Draft daemon's `slack-manager.sh` will maintain a persistent
Socket Mode connection to Slack, capturing messages in allowlisted channels to
`~/.draft/background/integrations/slack/captures/`. Every `DRAFT_SLACK_ANALYSIS` seconds,
`slack-analyzer.sh` rebuilds threads and synthesizes context updates as proposals.

---

## Step 0: Check existing configuration

```bash
python3 -c "
import json
from pathlib import Path

ws_file = Path.home() / '.draft' / 'active-profile'
profile = ws_file.read_text().strip() if ws_file.exists() else 'default'
secrets_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'secrets.json'

existing = {}
if secrets_path.exists():
    try:
        d = json.loads(secrets_path.read_text())
        existing['bot_token'] = bool(d.get('slack_bot_token'))
        existing['app_token'] = bool(d.get('slack_app_token'))
        existing['channels'] = d.get('slack_allowlist_channels', [])
        existing['mode'] = d.get('slack_capture_mode', '')
    except: pass

print(json.dumps(existing))
"
```

**If already configured:** Tell the user current status (mode, channel count) and ask:
"Slack is already configured. Want to reconfigure from scratch, or just update channels?"
- "reconfigure" → continue from Step 1
- "update channels" → jump to Step 4

**If not configured:** Continue to Step 1.

---

## Step 1: Create the Slack App

Tell the user:

> "To connect Slack, you'll need to create a Slack App in your workspace. I'll generate
> a pre-filled link and open it for you — it sets up all the required permissions automatically."

Generate the URL by reading `manifest.json` from the installed location:

```bash
python3 -c "
import urllib.parse, json, os

manifest_path = os.path.join(os.path.expanduser('~'), '.draft', 'background', 'integrations', 'slack', 'manifest.json')
manifest = json.loads(open(manifest_path).read())
encoded = urllib.parse.quote(json.dumps(manifest, separators=(',', ':')))
print(f'https://api.slack.com/apps?new_app=1&manifest_json={encoded}')
"
```

Store as `MANIFEST_URL`. Save it to a temp file so the user can re-open it without copy-pasting a long URL. Then open it automatically:

```bash
echo "$MANIFEST_URL" > /tmp/draft-slack-url.txt
open "$MANIFEST_URL" 2>/dev/null || true
```

Tell the user:

> "Opened the Slack app creation page in your browser."
>
> "If it didn't open, run: `open $(cat /tmp/draft-slack-url.txt)`"
>
> "Follow these steps on the page:
>
> 1. Review the pre-filled manifest and click **Create**
> 2. In the left sidebar, click **OAuth & Permissions**
> 3. Scroll down to **OAuth Tokens** → click **Install to [workspace]** → **Allow**
> 4. The **Bot User OAuth Token** (starts with `xoxb-`) now appears on this page — copy it
> 5. In the left sidebar, click **Basic Information** → scroll to **App-Level Tokens**
>    → click **Generate Token and Scopes** → name it anything → add scope `connections:write`
>    → **Generate** → copy the token (starts with `xapp-`)
>
> Come back with both tokens when you're ready."

**IMPORTANT: Use the `AskUserQuestion` tool** to ask: "Paste your Bot Token (xoxb-...) and App-Level Token (xapp-...) — you can paste both in one message."

---

## Step 2: Validate tokens

Parse the user's response to extract both tokens. Look for strings starting with `xoxb-` and `xapp-`.

**Validate the bot token:**

```bash
python3 -c "
import urllib.request, json, sys

bot_token = sys.argv[1]
req = urllib.request.Request(
    'https://slack.com/api/auth.test',
    headers={'Authorization': f'Bearer {bot_token}'}
)
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())
    print(json.dumps({'ok': data.get('ok'), 'team': data.get('team'), 'user': data.get('user'), 'error': data.get('error', '')}))
" "$BOT_TOKEN"
```

If `ok: false`: tell the user the bot token is invalid, show the error, ask them to re-check.

**Validate the app token** (tests Socket Mode auth before writing config):

```bash
python3 -c "
import urllib.request, json, sys

app_token = sys.argv[1]
req = urllib.request.Request(
    'https://slack.com/api/apps.connections.open',
    method='POST',
    headers={
        'Authorization': f'Bearer {app_token}',
        'Content-Type': 'application/x-www-form-urlencoded',
    },
    data=b''
)
try:
    with urllib.request.urlopen(req) as r:
        data = json.loads(r.read())
        if data.get('ok'):
            print('app_token:valid')
        else:
            print(f'app_token:invalid:{data.get(\"error\", \"unknown\")}')
except Exception as e:
    print(f'app_token:error:{e}')
" "$APP_TOKEN"
```

If `app_token:invalid:invalid_auth` or similar: tell the user:
> "The App-Level Token is invalid. The most common cause is generating the token before
> installing the app to your workspace. Make sure you completed Step 3 (Install to workspace)
> before generating the App-Level Token in Basic Information. You may need to delete the
> existing token and generate a new one after confirming the app is installed."

Do not proceed to Step 3 until both tokens validate.

If both valid: confirm "✅ Both tokens valid — connected to workspace: **{team}**".

---

## Step 3: Fetch users and available channels

Fetch the full user list and channel list in parallel using the bot token.

**Users:**

```bash
python3 -c "
import urllib.request, json, sys

bot_token = sys.argv[1]
url = 'https://slack.com/api/users.list?limit=200'
req = urllib.request.Request(url, headers={'Authorization': f'Bearer {bot_token}'})
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())
    members = [
        {'id': m['id'], 'name': m['name'], 'real_name': m.get('real_name', m['name']),
         'title': m.get('profile', {}).get('title', '')}
        for m in data.get('members', [])
        if not m.get('deleted') and not m.get('is_bot') and m['id'] != 'USLACKBOT'
    ]
    print(json.dumps(members))
" "$BOT_TOKEN"
```

**Channels:**

```bash
python3 -c "
import urllib.request, json, sys

bot_token = sys.argv[1]
req = urllib.request.Request(
    'https://slack.com/api/conversations.list?types=public_channel,private_channel&limit=200&exclude_archived=true',
    headers={'Authorization': f'Bearer {bot_token}'}
)
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())
    channels = sorted(
        [{'name': c['name'], 'id': c['id'], 'members': c.get('num_members', 0)}
         for c in data.get('channels', [])],
        key=lambda x: -x['members']
    )
    print(json.dumps(channels))
" "$BOT_TOKEN"
```

Store both lists. Continue to Step 4.

---

## Step 4: Select monitoring channels

Display the available channels as a numbered list:

> "Here are the channels in your workspace. Which should Draft monitor?
>
> ```
>  1. #product       (8 members)
>  2. #engineering   (6 members)
>  3. #design        (4 members)
>  4. #general       (12 members)
>  5. #random        (12 members)
> ```
>
> Enter numbers (e.g. `1,2`) or channel names."

Use `AskUserQuestion` to collect the selection.

**Important framing to include:**
> "Draft will passively monitor these channels to stay current on team activity.
> The bot reads messages but never posts. You'll need to manually invite it to
> each channel — I'll remind you at the end."

**IMPORTANT: Use the `AskUserQuestion` tool** to collect the channel selection.

Resolve the user's selection against the channel list fetched in Step 3.
Map selected numbers or names → channel IDs. No additional API call needed.

Build `SELECTED_CHANNELS` as a list of `{name, id}` dicts from the user's selection.
`SELECTED_CHANNEL_IDS` must be a plain list of ID strings: `[c['id'] for c in SELECTED_CHANNELS]`.

**If any channel is not found in the list:** Ask the user to check the name — it may be
a private channel the bot wasn't able to see (bot needs to be invited first to discover it).

Fetch recent messages from each found channel (last 50 messages) for role inference:

```bash
python3 -c "
import urllib.request, json, sys

bot_token = sys.argv[1]
channel_id = sys.argv[2]

req = urllib.request.Request(
    f'https://slack.com/api/conversations.history?channel={channel_id}&limit=50',
    headers={'Authorization': f'Bearer {bot_token}'}
)
with urllib.request.urlopen(req) as r:
    data = json.loads(r.read())
    messages = [
        {'user': m.get('user', 'unknown'), 'text': m.get('text', '')[:200]}
        for m in data.get('messages', [])
        if m.get('user') and not m.get('bot_id')
    ]
print(json.dumps(messages))
" "$BOT_TOKEN" "$CHANNEL_ID"
```

---

## Step 5: LLM role inference

Build a prompt that includes:
1. The list of users (id, name, real_name, title) from Step 3
2. Sample messages from each channel with user IDs attached
3. Instructions to infer each person's role based on posting behavior and topics

Prompt template:

```
You are analyzing a Slack workspace to infer team member roles for a Draft AI context system.

USERS:
<paste the JSON user list>

RECENT MESSAGES (last 50 per channel):
<paste messages with user_id and text>

Based on the posting patterns, topics, and user profile titles above, infer the likely role
of each active participant. Focus on:
- What topics do they discuss? (technical, product, sales, ops, etc.)
- Do they ask questions or answer them? (junior vs senior signal)
- What's their apparent seniority? (IC, lead, manager, exec?)

For each user who posted at least once, output:
  USER_ID | display_name | inferred_role

Only include users who actually posted. Be concise — one line per person.
Format: exactly "USER_ID | name | role" with pipe separators, one per line.
```

Run this inference using `claude -p` with the prompt inline (no file tools needed):

```bash
INFERRED=$(claude -p "$INFERENCE_PROMPT" 2>/dev/null)
echo "$INFERRED"
```

Parse the output — extract lines matching `USER_ID | name | role` pattern.

---

## Step 6: Confirm roles with user (human-in-the-loop)

Present the inferred roles clearly:

> "Here's what I inferred about your team based on Slack activity:"
>
> ```
> @alice      → Product Manager
> @bob        → Senior Engineer
> @carol      → Engineering Manager
> @dave       → Designer
> ```
>
> "Correct anything that's wrong, or say 'looks good' to accept."

**IMPORTANT: Use the `AskUserQuestion` tool** to ask: "Any corrections? (e.g. 'bob is actually a backend lead') — or just say 'looks good'"

Parse their response:
- "looks good" / "correct" / empty → accept all as-is
- Corrections like "bob is backend lead" → update that entry
- "skip" → save with empty roles (names only)

---

## Step 7: Write config files

Construct the Python snippet with actual string values substituted in — never pass placeholder
variable names. `slack_allowlist_channels` MUST be a JSON array of plain channel ID strings
(e.g. `["C012AB3CD", "C045EF6GH"]`), NOT objects. Extract IDs from the selected channel list.

Build and run `secrets.json`:

```bash
python3 - <<'PYEOF'
import json
from pathlib import Path

ws_file = Path.home() / '.draft' / 'active-profile'
profile = ws_file.read_text().strip() if ws_file.exists() else 'default'
secrets_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'secrets.json'

existing = {}
if secrets_path.exists():
    try: existing = json.loads(secrets_path.read_text())
    except: pass

# SUBSTITUTE real values below — channel IDs must be strings, not objects
existing['slack_bot_token'] = '<xoxb-token>'
existing['slack_app_token'] = '<xapp-token>'
existing['slack_allowlist_channels'] = ['<channel_id_1>', '<channel_id_2>']  # ID strings only
existing['slack_capture_mode'] = 'passive'

secrets_path.parent.mkdir(parents=True, exist_ok=True)
secrets_path.write_text(json.dumps(existing, indent=2))
print('secrets.json updated')
PYEOF
```

After writing, verify the format is correct:

```bash
python3 -c "
import json
from pathlib import Path
ws = Path.home() / '.draft' / 'active-profile'
profile = ws.read_text().strip() if ws.exists() else 'default'
s = json.loads((Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'secrets.json').read_text())
channels = s.get('slack_allowlist_channels', [])
print(f'channels type check: {[type(c).__name__ for c in channels]}')
print(f'all strings: {all(isinstance(c, str) for c in channels)}')
"
```

If `all strings: False` — the channels were stored as objects. Re-write secrets.json with correct IDs before continuing.

Build `slack-roles.json` (substitute real values):

```bash
python3 - <<'PYEOF'
import json
from pathlib import Path

ws_file = Path.home() / '.draft' / 'active-profile'
profile = ws_file.read_text().strip() if ws_file.exists() else 'default'
roles_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'slack-roles.json'

# SUBSTITUTE real values — keyed by user_id string
roles = {
    '<user_id>': {'name': '<name>', 'real_name': '<real_name>', 'role': '<role>'},
    # ... one entry per confirmed team member
}

# __channels: channel_id → channel_name mapping
roles['__channels'] = {
    '<channel_id>': '<channel_name>',
    # ... one entry per selected channel
}

roles_path.parent.mkdir(parents=True, exist_ok=True)
roles_path.write_text(json.dumps(roles, indent=2))
print('slack-roles.json written')
PYEOF
```

---

## Step 7b: Restart capture process (if running)

After writing new tokens, kill any running `slack-capture` process so the daemon
restarts it with the fresh config. Without this, a running process keeps stale
tokens in memory and fails with `invalid_auth` indefinitely.

```bash
CAPTURE_PID_FILE="$HOME/.draft/background/integrations/slack/capture.pid"
if [ -f "$CAPTURE_PID_FILE" ]; then
    CAPTURE_PID=$(cat "$CAPTURE_PID_FILE" | tr -d '[:space:]')
    if [ -n "$CAPTURE_PID" ] && kill -0 "$CAPTURE_PID" 2>/dev/null; then
        kill "$CAPTURE_PID"
        rm -f "$CAPTURE_PID_FILE"
        echo "capture:restarted"
    else
        rm -f "$CAPTURE_PID_FILE"
        echo "capture:stale-pid-cleared"
    fi
else
    echo "capture:not-running"
fi
```

Tell the user: "Restarted the Slack capture process — it will reconnect with your new tokens on the daemon's next 60-second cycle."

---

## Step 8: Verify daemon and confirm

Check if the daemon is running — try three detection methods in order:

```bash
DAEMON_STATUS="stopped"

# 1. PID file (written by start.sh / on-session-end.sh)
DAEMON_PID_FILE="$HOME/.draft/background/draft-daemon.pid"
if [ -f "$DAEMON_PID_FILE" ] && kill -0 "$(cat "$DAEMON_PID_FILE")" 2>/dev/null; then
    DAEMON_STATUS="running"
fi

# 2. LaunchAgent (installed by install.sh — most common)
if [ "$DAEMON_STATUS" = "stopped" ] && launchctl list com.draft.daemon &>/dev/null 2>&1; then
    DAEMON_STATUS="running"
fi

# 3. Process search (fallback)
if [ "$DAEMON_STATUS" = "stopped" ] && pgrep -f "draft-daemon.sh" >/dev/null 2>&1; then
    DAEMON_STATUS="running"
fi

echo "daemon:$DAEMON_STATUS"
```

Also check if `bun` is available:

```bash
if command -v bun >/dev/null 2>&1; then
    echo "bun:available:$(bun --version)"
else
    echo "bun:missing"
fi
```

Report to user:

```
Slack connected!

  Workspace:  <team_name>
  Channels:   #product, #engineering (2 channels)
  Mode:       passive (captures all messages)
  Roles:      5 team members mapped

  Config written:
    config/secrets.json      (tokens + channel list)
    config/slack-roles.json  (team member roles)

  Next — invite the bot to each monitored channel:
    Run in Slack: /invite @Draft Context
    Do this in:  #product, #engineering
    (The bot reads messages but never posts — this is required for capture to work.)

  Where messages are stored:
    ~/.draft/background/integrations/slack/captures/<channel_id>/YYYYMMDD.jsonl

  Check capture status after the daemon starts:
    PID file:  ~/.draft/background/integrations/slack/capture.pid
    Verify:    kill -0 $(cat ~/.draft/background/integrations/slack/capture.pid)
    Logs:      tail -f ~/.draft/background/logs/slack-capture.log
```

**If daemon is running:** Say "The daemon will pick up Slack on the next 60-second cycle — no restart needed."
**If daemon is stopped:** Say "Run `/draft:daemon start` to start the daemon and begin capturing."
**If bun is missing:** Say "⚠️  `bun` is not installed. Install it with: `curl -fsSL https://bun.sh/install | bash`. The daemon needs bun to run the Slack capture process."

Stop.
