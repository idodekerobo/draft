---
name: draft-connect-github
description: >
  Set up GitHub integration for the Draft daemon. Configures repo monitoring
  and team member mapping using the gh CLI. Writes config/github.json and
  config/integrations.json.
---

# /draft:connect github

Connect GitHub to the Draft daemon. The daemon will poll configured repositories hourly for merged PRs, new releases, and open PRs — then synthesize them into workspace context proposals automatically.

**Uses the `gh` CLI** — no GitHub App registration or webhooks required. The same `gh` auth used for team collaboration.

---

## Step 0 — Verify gh CLI

Run: `gh auth status`

If not authenticated:
- Offer to run `gh auth login --web` (opens browser)
- Hard stop if gh CLI not installed — tell user to install from https://cli.github.com

---

## Step 1 — Check existing config

Check if `$DRAFT_WORKSPACE/config/github.json` exists and has a non-empty `repos` array.
Also check if `$DRAFT_WORKSPACE/config/team-profiles.json` exists.

```bash
python3 -c "
import json
from pathlib import Path

profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
workspace = Path.home() / '.draft' / 'workspaces' / profile

github_config_path = workspace / 'config' / 'github.json'
repos = []
if github_config_path.exists():
    try:
        d = json.loads(github_config_path.read_text())
        repos = d.get('repos', [])
    except Exception:
        pass

profiles_path = workspace / 'config' / 'team-profiles.json'

print(f'repos:{\" \".join(repos)}')
print(f'profiles_configured:{profiles_path.exists()}')
"
```

If already configured:
> "GitHub is already connected (repos: [list repos]). What do you want to do?
> (1) Reconfigure  (2) Disconnect  (3) Cancel"

- Reconfigure → write `connected: false` to integrations.json first (run snippet below), then continue.
- Disconnect → run **Disconnect flow** below, then stop.
- Cancel → show current config and stop.

**Disconnect flow:**
```bash
python3 - <<'PYEOF'
import json
from pathlib import Path

profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
workspace = Path.home() / '.draft' / 'workspaces' / profile

integrations_path = workspace / 'config' / 'integrations.json'
integrations = {}
if integrations_path.exists():
    try: integrations = json.loads(integrations_path.read_text())
    except: pass
integrations['github'] = {'connected': False}
integrations_path.write_text(json.dumps(integrations, indent=2) + '\n')
print('github:disconnected')
PYEOF
```

Print: `✓ GitHub disconnected. Your github.json and team-profiles.json are preserved.`

---

## Step 2 — Which repos to monitor

Ask:
> "Which GitHub repos should Draft monitor for your team's activity? Enter as `org/repo` — you can add multiple separated by commas or spaces."

For each repo entered:
- Validate access: `gh repo view <repo> --json name` — confirm it works
- If validation fails: tell user which repo couldn't be accessed and ask to correct or skip

After validation, write `$DRAFT_WORKSPACE/config/github.json` with the validated repos:

```bash
python3 - <<'PYEOF'
import json
from pathlib import Path

profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
workspace = Path.home() / '.draft' / 'workspaces' / profile

config_dir = workspace / 'config'
config_dir.mkdir(parents=True, exist_ok=True)

repos_list = ["org/repo1", "org/repo2"]  # replace with actual validated repos list

github_config = {"repos": repos_list}
with open(config_dir / "github.json", "w") as f:
    json.dump(github_config, f, indent=2)
    f.write("\n")

print(f'wrote {len(repos_list)} repo(s) to {config_dir / "github.json"}')
PYEOF
```

Write integrations.json:

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

# Replace with actual validated repos list
integrations['github'] = {
    'connected': True,
    'repos': repos_list,
    'last_connected': datetime.utcnow().isoformat() + 'Z',
}
integrations_path.write_text(json.dumps(integrations, indent=2) + '\n')
print('integrations.json updated')
PYEOF
```

Substitute `repos_list` with the actual list of validated repos collected in this step.

---

## Step 3 — Team member mapping

Say:
> "Draft can map GitHub usernames to real names, making synthesized summaries easier to read. For example: 'James merged the auth PR' instead of 'jsmith merged PR #47'."

Ask:
> "Want to add your team members? I'll need their name and GitHub username. (You can skip this and add it later.)"

If yes:
- Collect entries one at a time:
  > "Name: [   ]   GitHub username: [   ]   Slack user ID (optional, press enter to skip): [   ]"
- Keep asking "Add another?" until done
- Write to `$DRAFT_WORKSPACE/config/team-profiles.json`:

```bash
python3 - <<'PYEOF'
import json
from pathlib import Path

profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
profiles_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'team-profiles.json'
profiles_path.parent.mkdir(parents=True, exist_ok=True)

# Replace with actual entries collected from user
entries = [
    {"name": "James Smith", "github": "jsmith", "slack": "U04XYZABC"},
    {"name": "Sarah Lee", "github": "sarahlee", "slack": None}
]

profiles_path.write_text(json.dumps(entries, indent=2) + '\n')
print(f'wrote {len(entries)} team profiles to {profiles_path}')
PYEOF
```

If no: skip this step. The synthesizer will fall back to raw GitHub usernames.

---

## Step 4 — Confirm and finish

Read the repos back from `$DRAFT_WORKSPACE/config/github.json` to confirm what was written, then show a summary:

```bash
python3 -c "
import json
from pathlib import Path

profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
github_config_path = Path.home() / '.draft' / 'workspaces' / profile / 'config' / 'github.json'

try:
    d = json.loads(github_config_path.read_text())
    repos = d.get('repos', [])
    print(', '.join(repos) if repos else '(none)')
except Exception:
    print('(could not read config)')
"
```

> "GitHub connected.
>
> Repos monitoring: [list from github.json]
> Team profiles: [N members mapped | not configured]
>
> The daemon will poll GitHub every hour. To trigger a manual poll now, restart the daemon:
> `draft stop && draft start`
>
> Or test directly:
> `draft poll github`"
