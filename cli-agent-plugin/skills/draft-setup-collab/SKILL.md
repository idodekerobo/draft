---
name: draft-setup-collab
description: >
  Collaboration configuration for Draft. Sets up gh CLI auth, configures the
  shared GitHub repo, writes config files, and seeds the shared repo on first
  use. Invoked from /draft:setup Q5.5 or run standalone at any time.
---

# /draft:setup-collab — Collaboration Configuration

Configure Draft to share your context layer with teammates via a shared GitHub repo.
Can be run standalone (`/draft:setup-collab`) or invoked inline from `/draft:setup`.

---

## Step 0: Resolve workspace path

Before writing any files, resolve the active workspace path at runtime — do not
rely on the `$DRAFT_WORKSPACE` env var, which may not reflect the current profile yet.

```bash
python3 -c "
from pathlib import Path
profile_file = Path.home() / '.draft' / 'active-profile'
profile = profile_file.read_text().strip() if profile_file.exists() else 'default'
ws = Path.home() / '.draft' / 'workspaces' / profile
print(str(ws))
"
```

Store the result as `ACTIVE_WORKSPACE`. Use it everywhere a workspace path is needed in this skill.

---

## Step 1: Check gh CLI

```bash
gh auth status
```

**If gh is not installed:**

```bash
uname -s
```

Use the **AskUserQuestion** tool to ask:
> "gh CLI isn't installed. Install it now? (macOS: `brew install gh` / Linux: `sudo apt install gh`)"

- If **yes**: run the appropriate install command, then re-run `gh auth status`.
  - If still not installed: hard stop — "Install gh CLI and re-run `/draft:setup-collab`."
- If **no**: hard stop — "gh CLI is required. Install it and re-run `/draft:setup-collab`."

**If installed but not authenticated:**

Use the **AskUserQuestion** tool to ask:
> "You're not logged into GitHub. Authenticate now with `gh auth login --web`?"

- If **yes**: run `gh auth login --web`. This opens the user's browser — terminal waits for OAuth callback.
  - If `--web` fails (SSH/headless/no browser): hard stop — "Run `gh auth login` in your terminal, then re-run `/draft:setup-collab`."
  - After auth: verify with `gh auth status`. If still not authenticated: hard stop.
- If **no**: hard stop — "GitHub auth is required. Run `gh auth login` and re-run `/draft:setup-collab`."

**If installed and authenticated:** proceed to Step 2.

---

## Step 2: Clarify intent

Use the **AskUserQuestion** tool to ask:
> "Are you the first person on your team setting up Draft — or are you connecting to a shared repo your teammate already configured?"

- **"First person / setting it up"** → curator path → go to **Step 2a (choose repo)**
- **"Connecting to existing"** → teammate path → go to **Step 2b (enter URL)**

---

## Step 2a: Choose / create repo (curator path)

Get the authenticated username:

```bash
gh api user --jq .login
```

Use the **AskUserQuestion** tool to ask:
> "Create a new private GitHub repo, or use one you already have?
> A) Create new repo (default name: `draft-context`)
> B) Use existing repo — I'll paste the URL"

**Option A — New dedicated repo:**

Use the **AskUserQuestion** tool to ask:
> "What should the repo be called? (Press Enter for `draft-context`)"

- If the user presses Enter or leaves blank: use `draft-context`.
- Otherwise: use their input, slugified (lowercase, hyphens only, no spaces).

Create the repo:
```bash
gh repo create [username]/[repo-name] --private --description "Draft team context"
```

Set: `team_repo_url = github.com/[username]/[repo-name]`, `team_repo_subdir = root`

**Option B — Existing repo:**

Use the **AskUserQuestion** tool to ask:
> "Paste the GitHub repo URL (e.g. `github.com/your-org/your-repo`):"

Then use the **AskUserQuestion** tool to ask:
> "Which folder inside that repo should Draft write to? (Press Enter for `.draft`, or type a path like `context` or `/` for root)"

- Enter pressed → `team_repo_subdir = .draft`
- `/` entered → `team_repo_subdir = root`
- Custom path typed → `team_repo_subdir = [user input]`

**For either option — verify the repo:**

```bash
gh repo view [team_repo_url] --json name,isPrivate,isEmpty
```

- If repo not found: "Can't find that repo. Check the URL and try again." Loop back to top of Step 2a.
- If public: use the **AskUserQuestion** tool to ask:
  > "That repo is public — your product context will be visible to anyone. Continue anyway?"
  - If no (default): loop back to Step 2a.
  - If yes: proceed.

Proceed to **Step 3**.

---

## Step 2b: Connect to existing repo (teammate path)

Use the **AskUserQuestion** tool to ask:
> "Paste the GitHub repo URL your teammate shared with you:"

Then use the **AskUserQuestion** tool to ask:
> "Which folder inside that repo does Draft use? (Press Enter for `.draft`, or type the path your teammate set — usually `root` or `.draft`)"

- Enter pressed → `team_repo_subdir = .draft`
- `/` or `root` entered → `team_repo_subdir = root`
- Custom path typed → `team_repo_subdir = [user input]`

Verify the repo:
```bash
gh repo view [team_repo_url] --json name,isPrivate
```

If not found: "Can't reach that repo. Check the URL and your access, then try again." Hard stop.

Proceed to **Step 3**.

---

## Step 3: Write config files

Create the config directory:
```bash
mkdir -p "[ACTIVE_WORKSPACE]/config"
```

Get the authenticated username:
```bash
gh api user --jq .login
```

Write `[ACTIVE_WORKSPACE]/config/collaboration.json`:

```json
{
  "mode": "github",
  "team_repo_url": "[from step 2]",
  "team_repo_subdir": "[from step 2]",
  "repo_is_private": true/false,
  "teammates": ["[gh username]"]
}
```

Write `[ACTIVE_WORKSPACE]/config/local.json`:

```json
{
  "gh_cli_authenticated": true,
  "last_published": null,
  "last_loaded": null
}
```

After writing both files, verify they exist:
```bash
ls "[ACTIVE_WORKSPACE]/config/collaboration.json" "[ACTIVE_WORKSPACE]/config/local.json"
```

If either is missing: "Failed to write config files. Check permissions on `[ACTIVE_WORKSPACE]/config/`." Hard stop.

---

## Step 4: Check if shared repo is seeded

Clone to a temp directory. Use a prefixed variable name to avoid colliding with the system `$TMPDIR` env var.

**Handle new empty repos:** A brand-new repo has no commits and cannot be cloned normally. Detect this case first:

```bash
DRAFT_TMP=$(mktemp -d /tmp/draft-check-XXXX)
git clone --depth 1 [team_repo_url] "$DRAFT_TMP" 2>&1
CLONE_EXIT=$?
```

Interpret the result:

- **Exit 0 (clone succeeded):** Repo has content. Check for the seeded signal:
  ```bash
  # Adjust check path based on team_repo_subdir:
  # root → DRAFT_TMP/config/collaboration.json
  # .draft → DRAFT_TMP/.draft/config/collaboration.json
  # custom → DRAFT_TMP/[subdir]/config/collaboration.json
  if ls "[DRAFT_TMP]/[subdir_path]/config/collaboration.json" 2>/dev/null; then
    echo "SEEDED"
  else
    echo "NOT_SEEDED"
  fi
  ```
  Then: `rm -rf "$DRAFT_TMP"`

- **Non-zero exit with "empty repository" or "remote HEAD refers to nonexistent ref" in output:** Brand new empty repo. This is the curator path — treat as `NOT_SEEDED`.
  Then: `rm -rf "$DRAFT_TMP"`

- **Non-zero exit with another error (auth, not found, network):** Print the error. Hard stop — "Could not reach the repo. Check your access and try again."
  Then: `rm -rf "$DRAFT_TMP"`

**If `NOT_SEEDED`:** Draft has not been configured here. This user is the curator. → Go to Step 5 (seed).

**If `SEEDED`:** Existing Draft setup found. This user is a teammate. → Go to Step 6 (teammate complete).

---

## Step 5: Seed the shared repo (curator path only)

Show: "Seeding the shared repo with your current context..."

Execute the publish flow inline (do not rely on a flag — run the steps directly):

**5a. Collect context to publish:**

```bash
ls "[ACTIVE_WORKSPACE]/context/"
```

Check which dimension `index.md` files have real content (description is not "No information recorded yet"):

```bash
python3 -c "
from pathlib import Path
ws = Path('[ACTIVE_WORKSPACE]')
dims = ['company', 'product', 'team', 'priorities']
for dim in dims:
    idx = ws / 'context' / dim / 'index.md'
    if idx.exists():
        text = idx.read_text()
        has_content = 'No information recorded yet' not in text and len(text.strip()) > 50
        print(f'{dim}:{\"yes\" if has_content else \"no\"}')
"
```

**5b. Clone repo, write files, push:**

```bash
DRAFT_SEED=$(mktemp -d /tmp/draft-seed-XXXX)
git clone [team_repo_url] "$DRAFT_SEED" 2>&1
SEED_CLONE_EXIT=$?
```

- If clone fails with "empty repository": initialize the first commit:
  ```bash
  git -C "$DRAFT_SEED" init
  git -C "$DRAFT_SEED" remote add origin [full_https_team_repo_url]
  ```

Set the subdir prefix:
```bash
# team_repo_subdir = root → SEED_TARGET="$DRAFT_SEED"
# team_repo_subdir = .draft → SEED_TARGET="$DRAFT_SEED/.draft"
# team_repo_subdir = custom → SEED_TARGET="$DRAFT_SEED/[custom]"
mkdir -p "$SEED_TARGET/context" "$SEED_TARGET/config"
```

Copy context and config:
```bash
cp -r "[ACTIVE_WORKSPACE]/context/" "$SEED_TARGET/context/"
cp "[ACTIVE_WORKSPACE]/config/collaboration.json" "$SEED_TARGET/config/collaboration.json"
```

Build an initial `CHANGES.jsonl` entry:
```bash
ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
gh_username=$(gh api user --jq .login)
id=$(echo -n "${ts}${gh_username}setup" | shasum -a 256 | cut -c1-8)
echo "{\"id\":\"${id}\",\"ts\":\"${ts}\",\"author\":\"${gh_username}\",\"dimension\":\"all\",\"summary\":\"Initial Draft setup — context seeded by curator\",\"file\":\"context/\",\"log_entry\":null}" > "$SEED_TARGET/CHANGES.jsonl"
```

Stage, commit, push:
```bash
git -C "$DRAFT_SEED" add .
git -C "$DRAFT_SEED" commit -m "Initial Draft setup — context seeded"
git -C "$DRAFT_SEED" push origin HEAD:main 2>&1 || git -C "$DRAFT_SEED" push origin HEAD:master 2>&1
PUSH_EXIT=$?
```

Clean up:
```bash
rm -rf "$DRAFT_SEED"
```

- **If push succeeded (exit 0):** Update `[ACTIVE_WORKSPACE]/config/local.json` — read the file with `json.loads()`, set `last_published` to the current ISO 8601 timestamp, write back with `json.dumps()`. → Go to Step 6 (curator complete).
- **If push failed:** Print the error. "Initial publish failed — your config is saved locally. Run `/draft:publish-team` when you're ready to share your context." → Go to Step 6 (curator complete, with publish-failed note).

---

## Step 6: Confirm and next steps

**Curator path (seeded successfully):**

Get the org/user and repo name from `team_repo_url` to construct URLs.

Print:
```
✓ Collaboration configured.

Repo:     [full team_repo_url]
Subdir:   [team_repo_subdir]
Config:   [ACTIVE_WORKSPACE]/config/collaboration.json

Your context is live. Share this with your teammates:
  Repo URL:         https://[team_repo_url]
  Collaborators:    https://github.com/[org]/[repo]/settings/access

When a teammate runs /draft:setup, they'll be asked if they want to connect
to a shared repo — they should answer "connecting to existing" and paste this URL.

Run /draft:publish-team whenever your context changes to push updates.
```

**Curator path (publish failed):**

Print:
```
✓ Collaboration configured — config saved locally.

Repo:     [full team_repo_url]
Config:   [ACTIVE_WORKSPACE]/config/collaboration.json

Initial publish failed (see error above). Run /draft:publish-team when ready to push your context.
```

**Teammate path (connected to existing repo):**

Print:
```
✓ Connected to team repo.

Repo:     [full team_repo_url]
Subdir:   [team_repo_subdir]
Config:   [ACTIVE_WORKSPACE]/config/collaboration.json

Run /draft:load-team to pull your team's latest context into this workspace.
```
