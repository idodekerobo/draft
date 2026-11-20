# Draft CLI

The Draft CLI is a thin authenticated client for the hosted or self-hosted Draft control plane. It is useful for scripts, agents, project setup, and coding-session access without opening the desktop app.

The CLI is one of Draft's two agent connection paths. Use it for setup, scripts, project instructions, and explicit reads; use the remote MCP server when an MCP-compatible agent should query the company brain directly during a session. The connection surface is evolving, so prefer the command help and this reference over older daemon or GitHub-sync documentation.

## Install

~~~bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
~~~

Released binaries currently support macOS arm64/x64 and Linux x64. The compiled binary is installed under ~/.draft/bin/draft and linked onto PATH.

## Configuration

The CLI defaults to:

- API: https://api.draftai.us
- App: https://app.draftai.us

For another deployment, set:

~~~env
DRAFT_API_BASE_URL=https://api.example.com
DRAFT_APP_URL=https://app.example.com
DRAFT_SUPABASE_URL=https://your-project.supabase.co
DRAFT_SUPABASE_PUBLISHABLE_KEY=your-public-key
~~~

The Supabase URL and publishable key are required by the compiled/source CLI auth path. They are public client values; never use the Supabase secret key in the CLI.

## Authentication

~~~bash
draft auth login
draft auth whoami
draft auth logout
~~~

`draft auth login` prints a sign-in link and a short code, such as `K7M-4QX`. Open the link, sign in, and type the code on the page. The code proves the sign-in is the one you started, so only approve a sign-in you started yourself. The CLI sign-in is stored separately from the desktop app's.

With `--json` (for example, when an agent runs it for you), it prints one line first and then the result:

~~~json
{"status":"action_required","action":"sign_in","url":"https://app.draftai.us/link?code=…","confirmCode":"K7M-4QX","expiresInSeconds":300}
~~~

## Context

~~~bash
draft context list
draft context read --dimension product
draft context read --all
~~~

Context reads go through the authenticated API and return the current workspace snapshot. A missing workspace is an account/onboarding state, not a local initialization step.

### Export your context

~~~bash
draft context export                        # extract into ./draft-context
draft context export --out ~/brain          # extract into another folder
draft context export --zip draft-context.zip   # save the zip as is
draft context export --json
~~~

Export writes every document in the current workspace snapshot, including `memory/`, as plain markdown. It adds a `README.md` that explains the layout and a `draft-export.json` with the version, content hash and export time. Open the folder in any agent (for example `cd draft-context && claude`).

- The folder is refused if it is not empty. Pass `--force` to write into it anyway; existing files with the same name are overwritten.
- `--zip` refuses to overwrite an existing file unless you pass `--force`.
- The CLI checks every path in the zip before it writes anything. A zip with an absolute path, `..` or a backslash writes nothing.
- `--json` prints `{ path, fileCount, versionNumber }`.
- The export is a copy outside Draft's access control. Anyone with the files can read them.

### Memory (chronological log)

Unlike the other dimensions, which hold a single current-state document per
dimension, `memory` is a workspace-wide chronological log of day/week/month
documents — recomputed continuously rather than only reflecting the latest
state. Read one period with `--period`:

~~~bash
draft context read --dimension memory --period today
draft context read --dimension memory --period this-week
draft context read --dimension memory --period last-month
draft context read --dimension memory --period 2026-09-16   # explicit day
draft context read --dimension memory --period week-2026-09-21   # explicit week, by its Monday
draft context read --dimension memory --period 2026-09      # explicit month
~~~

`--period` requires exactly one `--dimension` (not `--all`, not multiple), and
only `memory` supports it today. Aliases (`today`, `this-week`, `this-month`,
and their `last-`/`yesterday` counterparts) resolve using the workspace's
configured timezone, not your local machine's.

## MCP connection

Draft also exposes the same company brain through an OAuth-protected remote MCP server. Register the hosted endpoint in an MCP-compatible agent:

~~~text
https://api.draftai.us/mcp
~~~

The first connection uses Draft's browser sign-in and consent flow. Sign-in asks for read and write access, so your agent can read context and also manage routines, skills and connections for you. See [MCP and agent connections](./mcp.md) for the full tool list.

Claude Code can register it with:

~~~bash
claude mcp add --transport http draft https://api.draftai.us/mcp
~~~

Codex can use the equivalent HTTP entry in `~/.codex/config.toml`:

~~~toml
[mcp_servers.draft]
url = "https://api.draftai.us/mcp"
~~~

For self-hosted Draft, replace the hosted URL with `<DRAFT_API_BASE_URL>/mcp`. MCP and CLI reads resolve the same authenticated team workspace; neither requires a local company-brain repository.

## Skills

Skills are the company's skill marketplace — reusable procedures, templates, and heuristics a teammate saves once so any future agent can find and follow them. Unlike context, this is a write path: instant-publish, team-scoped, no approval queue.

~~~bash
draft skills list
draft skills read <name>
draft skills add [<name>] [--description "<when to use this>"] (--file <path> | --content "<text>" | stdin)
draft skills update <name> [--description "<text>"] (--file <path> | --content "<text>" | stdin)
draft skills remove <name>
~~~

`name`/`description` are optional on `add` when the content starts with standard YAML frontmatter (SKILL.md-style: `---\nname: ...\ndescription: ...\n---`) — the backend parses `name`, `description`, and the optional `license`/`compatibility`/`metadata`/`allowed-tools` fields. Explicit flags always override parsed frontmatter values. `name` must match `^[a-z0-9]+(-[a-z0-9]+)*$`, max 64 chars.

Content can come from a local file (`--file`), inline text (`--content`), or piped stdin — a conversational agent often has pasted or described text rather than a local path.

`add` rejects a duplicate active name (use `update` instead); `remove` soft-deletes, hiding the skill from `list`/`read` immediately while preserving its content and author for the rare postmortem — the name becomes reusable by a later `add`. `update` overwrites content/description in place with no version history; `updated_at`/`updated_by` make an overwrite attributable even though the prior content isn't recoverable.

`list` shows every active skill's full description text (not truncated); `read <name>` returns the full content plus every optional field.

## Routines

Routines are work Draft runs once, on a repeating schedule, on events, or when you run them manually. See [Routines](./routines.md) for the app's Activity and Routines views. Each command matches one MCP tool of the same name (`draft routines list` is `routines.list`), and `--json` prints that tool's answer. Run `draft routines <command> --help` for every flag and example.

~~~bash
draft routines options                     # triggers, schedule presets, agents, Slack channels, GitHub repos
draft routines list [<id>]                 # repeating/event routines, or one routine by id
draft routines list --once                 # one-time routines, including ones that already fired
draft routines list --upcoming --mine      # your one-time routines that have not fired
draft routines list --fired                # one-time routines that already fired
draft routines create --title <t> (--prompt <text> | --prompt-file <path>) --harness <claude|codex> (--in <duration> | --at <iso-time> | --preset <preset> | --on <event>) [options]
draft routines update <id> [options]       # change only the fields you pass
draft routines delete <id>                 # cancel a pending one-time routine, or delete a repeating/event routine
draft routines run <id> [--wait]           # run now; --wait follows a started run and prints its result
draft routines runs <id> [--cursor <c>]     # 50 at a time; --cursor shows older runs
draft routines runs <id> --session-id <id> [--transcript [--cursor <n>]]
~~~

### Choose when it runs

~~~bash
# Once, two hours from now
draft routines create --title "Check PR" --prompt "Check the review status of acme/api PR #42 and report remaining blockers." --harness claude --in 2h

# Once, at a specific instant; include Z or an explicit timezone offset
draft routines create --title "Release check" --prompt "Check the acme/api release status and report any failed checks." --harness claude --at 2026-12-01T09:00:00-05:00

# Repeat daily, and also run when a Linear issue is created
draft routines create --title "Triage" --prompt "Review newly created Linear issues and summarize urgent work." --harness claude --preset daily --time 09:00 --timezone America/New_York --on linear.issue_created

# Events only, with no repeating schedule
draft routines create --title "New issues" --prompt "Review each new Linear issue and summarize any missing information." --harness claude --on linear.issue_created

# Schedule another future check, including after a one-time routine has fired
draft routines update <id> --in 2h
~~~

`--in` accepts a positive whole number followed by `m`, `h` or `d`, such as `10m`, `2h` or `3d`. `--at` accepts an ISO timestamp with an offset. Both require a future time no more than 365 days away. They cannot be combined with each other or with schedule/event flags. Use `--preset` with `--on` to combine a repeating schedule and events; `--on` alone creates an event-only routine.

Instructions must be a self-contained brief: what to do, why, and what done means. The future run cannot see the conversation that scheduled it.

| Setting | Meaning |
| --- | --- |
| `--model <id>` | The agent's model. See `draft routines options`. |
| `--in <duration>`, `--at <iso-time>` | Run once, or reschedule a one-time routine. |
| `--preset <preset>` | `draft_default`, `hourly`, `daily`, `weekdays` or `weekly`. |
| `--time HH:MM`, `--weekday <day>`, `--timezone <zone>` | Time on a 24-hour clock, weekday (`sun`…`sat`) and IANA timezone. Daily, weekdays and weekly use a time; weekly uses a weekday. |
| `--on <trigger>` | Run on this event. Repeat the flag or pass a comma list. |
| `--notify` / `--no-notify` | Allow or forbid the agent to message teammates on Slack. |
| `--post-channels joined` or `--post-channels '#general,#eng'` | Where the agent can post on Slack. `--no-post` removes that access on update. |
| `--github owner/repo[,owner/repo]` | GitHub repos the agent can use. `--github-access read` is the default; `write` lets it open pull requests. `--no-github` removes access on update. |
| `--schedule` / `--no-schedule` | On update, turn the repeating schedule on or off. Event triggers remain active when the schedule is off. |
| `--no-triggers` | On update, remove every event trigger. |
| `--enable` / `--disable` | On update, enable or pause automatic runs. A fired one-time routine needs a new time to be scheduled again. |

One-time routines are hidden from `list` by default. `--once` selects them; `--upcoming` and `--fired` imply `--once` and cannot be combined. `--mine` shows routines created by you. Filters apply to the list, so do not combine them with an individual `<id>`.

One-time rows show their scheduled time or when they fired. Routines an agent made have a “made by an agent” label. A trigger or access that needs a provider you haven't connected is refused, with the command to connect it, for example `draft connections connect --provider linear`. An agent that isn't set up for routines in your workspace is refused too, with how to set it up. Failed commands print the error and exit nonzero.

`run <id>` requests an immediate run, including for a paused routine or a one-time routine that already fired. If work for it is in progress, the request is queued until that work ends; the response has `queued: true` and no run ID. In that case `--wait` returns the queued result rather than waiting. Otherwise, use the returned run ID with `runs`, or use `--wait` to follow it immediately. A manual run does not repeat the original one-time delay.

`runs` lists status, what started each run, its result, and why a skipped run was skipped. `--transcript` shows what the agent did, a page at a time. When there are older runs or more transcript, the output ends with the command for the next page.

## People

`draft people` shows who Draft knows in your workspace and how to reach them. A person is not always a Draft user: it can be someone named in a meeting who has no account. Each command calls one MCP tool as you, and `--json` prints the tool's answer.

| Command | What it does |
| --- | --- |
| `draft people find [name] [--me] [--email <address>] [--status <s>]` | Find people. It never prints emails or ids of other systems |
| `draft people create <name> [--email <a>] [--slack <id>] [--quote <why>] [--force]` | Add a teammate. An admin's addition is active, anyone else's waits for approval |
| `draft people update <id or name> --provider <p> ...` | Record, correct or remove a way to recognise a person (below) |
| `draft people pending` | Who is waiting for approval |
| `draft people approve <id or name>` / `reject <id or name> [--reason <why>]` | Admins only |
| `draft people notify <id or name> <message> [--link <url>]` | Send a message to a person |

### `draft people update`

A person has several ways to be recognised: an email, a Slack id, a Linear or GitHub id, a phone number. `update` changes them. Name the person by id or by name; a name has to match exactly one person, whatever their status. `--provider` is one of `email`, `slack`, `linear`, `github`, `whatsapp`. Each command makes one change, never a mix:

```bash
# Add one
draft people update cory --provider slack --external-id U0123 --handle cory --quote "Cory posted as U0123"

# Correct one, in a single step
draft people update cory --provider email --replace cory@typo.com --external-id cory@right.com

# Remove one
draft people update cory --provider slack --remove U0123
```

- `--external-id` is the id: an email address, a Slack member id, and so on. Emails are matched without regard to case.
- `--handle` is a display name only. It is never used to match. `--quote` and `--source-item <id>` (from `draft sources search`) say where you learned the id.
- **What you add is a guess** until a connection sees the same id, such as Slack's member sync. A guess cannot be used to message the person.
- **Only a guess can be replaced or removed.** An id that comes from a workspace member or a connection is kept in step with that source, so the command refuses it with `identity_trusted`. Change it at the source.
- An id that belongs to someone else is refused with `identity_taken` when you add or replace. When you remove or replace an id the person doesn't have, the answer is `identity_not_found`, whoever owns it.
- A replace adds the corrected id first. If it belongs to someone else, the old id stays.

## Activity

`draft activity list` shows everything the workspace's agents have run, newest first, 50 at a time: routine runs, context updates, session summaries and interactive sessions. It's the same list as the Activity page, and matches the MCP tool `activity.list`.

~~~bash
draft activity list [--json]
draft activity list --cursor '<cursor from the last page>'
~~~

Each routine run includes the command that shows it, for example `draft routines runs <routine id> --session-id <session id>`.

On the first page, `--json` also includes `upcoming`: pending one-time routines, soonest first, with their scheduled time and who set them. If that part cannot load, `upcomingError: true` is returned alongside the past runs. Run rows include `routineKind` and `createdRoutines` when applicable. The plain-text command prints past runs; use `draft routines list --upcoming` for a readable pending list. In the app, Activity also offers Cancel and Run again.

## Project agent setup

Use draft add to write a managed Draft context block to a project's instruction file:

~~~bash
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
draft add cursor --dir /path/to/project
~~~

The command is project-local. It does not install a global daemon or initialize a local company-brain repository. The generated instructions tell the agent how to use the CLI to read the current workspace.

## Sessions

`draft sessions` lists interactive conversations created in the Draft app. `draft activity list` shows agent runs; captured coding sessions are ingested evidence and live under `draft sources`.

~~~bash
draft sessions list
draft sessions list --provider codex --since 2026-11-17
draft sessions read <session-id>
~~~

`--provider` filters by the app harness (`claude`, `codex`, and others). Listing is newest first and paginated; pass the returned cursor to continue. Reading returns session details and a page of events; use `--after-seq` to continue through a long event feed. `--json` returns machine-readable output.

## Sources

Context is Draft's maintained business map. Sources are ingested evidence across providers, including captured coding sessions. List sources to browse the catalog, search to find matching content, and read an item to inspect its captured representation.

```bash
draft sources list --type coding_session
draft sources list --provider claude_session --type coding_session --since 2026-11-17
draft sources search "database migration" --type coding_session
draft sources read <source_item_id> --representation transcript
```

### `draft sources list [--provider <p>] [--type <t[,t...]>] [--since <UTC>] [--until <UTC>] [--limit <n>] [--cursor <opaque>] [--json]`

Lists active source items newest first without searching their content. `--type coding_session` narrows the catalog to captured coding sessions. Results contain source metadata and available representations; use `sources.read` for content. The default page contains 50 items; the maximum is 100. Cursors continue the same filters and sort order.

### `draft sources search "<query>" [--provider <p>] [--type <t[,t...]>] [--since <UTC>] [--until <UTC>] [--limit <n>] [--max-bytes <n>] [--cursor <opaque>] [--json]`

Full-text searches each source item's stored default representation — a summary, rendered source content, or mixed content, depending on the provider. A readable original transcript may not be searchable: search only covers what was captured as the default representation.

- `--provider <p>` — restrict to one provider (for example `slack`, `github`, or `claude_session`).
- `--type <t[,t...]>` — restrict to one or more item types, comma-separated.
- `--since` / `--until` — UTC timestamps; `since` is inclusive and `until` is exclusive.
- `--limit <n>` — default 10, maximum 100.
- `--max-bytes <n>` — caps the serialized response; default 32,768, accepted range 1,024–262,144.
- `--cursor <opaque>` — continue a previous page. Search cursors bind to the query and filters.

Results are ranked by relevance, then recency. `consistency: "live"` means there is no cached or eventually-consistent mode.

### `draft sources read <source_item_id> [--representation default|transcript|messages|structured] [--max-bytes <n>] [--cursor <opaque>] [--json]`

Reads one source item's content directly. `default` returns the stored searchable content. A provider-specific `transcript`, `messages`, or `structured` representation is available only when it was captured. Large content pages through `--cursor`.

### Capture Claude Code sessions

Capture setup installs a project-local Claude Code SessionEnd hook:

~~~bash
draft sources capture enable claude-code --dir /path/to/project
draft sources capture status --dir /path/to/project
draft sources capture rotate --dir /path/to/project
draft sources capture disable --dir /path/to/project
~~~

The hook reads the completed transcript locally and posts it to Draft. The ingest credential is scoped to this project and provider, and is committed in `.claude/draft/config.json`; anyone with repo access can use it to submit sessions, but it cannot read or search them. Until the config and `.claude/settings.json` hook are committed and pushed, capture only works in the current working copy.

Only Claude Code capture is supported today. The `draft sessions enable|status|rotate|disable` forms remain deprecated aliases. Codex app sessions appear under `draft sessions`; Codex capture as source evidence is not supported.

## Output and updates

Commands support `--json` for machine-readable output. `draft update` checks for and installs a newer compiled release. Updates replace the CLI binary; they do not replace the server-side workspace.

---

## Project setup

### `draft add <tool> [--dir <path>...] [--json]`

Configures a project so its coding agent can discover Draft and the commands it may call (`draft auth login`, `draft context list`, `draft context read`). It does **not** install the `draft` CLI binary (installed separately — see [Running from source](../README.md#running-from-source)), does not run or bootstrap a background daemon, and does not touch global tool configuration. It writes to exactly one file, in exactly the directories you pass.

```bash
draft add claude-code --dir ~/code/my-app
draft add codex --dir ~/code/my-app --dir ~/code/another-app
draft add cursor --dir .
draft add openclaw --dir . --json
```

`--dir` is repeatable — pass it once per project you want to configure. If you omit it in an interactive terminal, you're prompted for one or more directories (defaulting to the current directory). Without a TTY (e.g. in a script or CI), a missing `--dir` fails immediately with exit code `2` — it never waits on stdin.

Each directory must already exist; a missing path, a path that isn't a directory, or an instruction-file target that is a symlink is rejected for that directory without touching it.

**Tool → instruction file:**

| Tool | File |
| --- | --- |
| `claude-code` | `CLAUDE.md` |
| `codex` | `AGENTS.md` |
| `cursor` | `AGENTS.md` |
| `openclaw` | `AGENTS.md` |
| `hermes` | `HERMES.md` |

`draft add` appends or updates one short, sentinel-delimited Draft-managed block in that file — it only points the agent at the CLI commands above (including the "### Skills" marketplace-discovery instructions, read and write directions both), it never copies or embeds context content into the file. Everything outside the sentinels (your own instructions) is preserved byte-for-byte. The block is identical across tools, so `draft add codex --dir .` followed by `draft add cursor --dir .` converge on the same `AGENTS.md` block rather than duplicating it, and running the same command twice makes no write once the block is already current.

Rerunning `draft add` in an already-configured project is the only way that project's instruction file picks up new managed-block content (like the Skills section) added by a later CLI release — the block isn't retroactively updated.

```bash
draft add codex --dir ./my-repo
draft add cursor --dir ./my-repo   # updates the same AGENTS.md block, no duplicate
```

```json
$ draft add claude-code --dir ./my-repo --json
{"schema_version":1,"status":"ok","tool":"claude-code","results":[{"dir":"./my-repo","ok":true,"file":"/abs/path/my-repo/CLAUDE.md","changed":true}]}
```

If any of the given directories fail validation, `status` is `partial_error`, each directory's own result reports `ok` and, on failure, a `code` (`directory_not_found`, `not_a_directory`, or `symlink_target`) and `message` — directories that did validate are still written. Exit code is `1` if any directory failed, `0` if all succeeded.

---

## Hosted connections

`draft connections` connects and manages your workspace's data sources: GitHub, Linear, Slack, Fireflies, Granola, Claude Code, and Google (Gmail). This is different from `draft add`: `add` points a coding agent *inside a project* at the CLI's read commands (`auth login`, `context list`, `context read`); `connections` is workspace-level and has nothing to do with any one project's directory. Run `draft connections <command> --help` for details.

### `draft connections list [--provider <provider>] [--available ...] [--json]`

Shows each provider: its status, what it brings into Draft, the routine triggers and abilities it unlocks, and how to connect it if it isn't connected. Status is one of:

- `connected`
- `pending`: saved, waiting for its first event. Fireflies and Granola stay pending until the provider sends Draft its first meeting or note.
- `needs_reconnect`: it stopped working and needs to be connected again.
- `not_connected`

It also lists what you can do with each provider: for Slack, `read`, `post`, `join` and `leave`. For Slack it lists the channels the bot has joined, with their ids.

`--json` prints the same answer as the MCP tool `connections.list`.

#### See every Slack channel

`--available` also lists every public Slack channel, including the ones the bot is already in. It needs `--provider slack`, and it is for people: a routine sees only the channels it may use.

| Form | Shows |
| --- | --- |
| `list --provider slack` | Slack's status and the channels the bot has joined, with ids |
| `list --provider slack --available` | Also every public channel, biggest first: name, id, member count, and whether the bot is in it (`in` or `not in`). 50 per page |
| `list --provider slack --available --query eng` | Only channels whose name contains `eng`. Case and a leading `#` do not matter |
| `list --provider slack --available --limit 100` | How many channels per page, 1 to 100 |
| `list --provider slack --available --cursor '<cursor>'` | The next page. A page that has more ends with a `More:` line holding the exact command. The last page has none |
| add `--json` to any of them | The tool's answer: `channels` is the joined list, and `available.channels` and `available.nextCursor` (`null` on the last page) are the page |

Slack has no search or offset call for channels, so each request walks Slack's pages and then filters and slices. That is fine for hundreds or a few thousand channels, and every page repeats the walk.

`draft connections list --provider slack --help` shows all of these forms.

```bash
draft connections list
draft connections list --provider slack
draft connections list --provider slack --available --query eng --limit 20
draft connections list --json
```

### Connect through a link

When you run `connect` with `--json`, or without a terminal (for example, when an agent runs it for you), the CLI never asks for a key. It prints a link instead:

```json
{"status":"action_required","action":"connect_linear","provider":"linear","url":"https://app.draftai.us/connect/…","expiresAt":"…"}
```

Open the link and connect the provider on that page in the Draft app. The link works once, only for you, for 15 minutes, and your key never passes through the CLI or the agent. Add `--wait` to keep checking until the provider is connected.

```bash
draft connections connect --provider linear --json
draft connections connect --provider linear --json --wait
```

### `draft connections connect --provider <provider> [--json] ...`

In an interactive terminal, without `--json`, `connect` runs each provider's own flow:

| Provider | Extra flags | TTY-only? | Terminal status on success |
| --- | --- | --- | --- |
| `github` | `--no-open` | No (polls; no credential prompt) | `connected` |
| `linear` | `--credential-stdin` \| `--credential-fd <n>` | No | `connected` |
| `claude-code` | `--credential-stdin` \| `--credential-fd <n>` | No | `credential_stored` (not live-validated) |
| `slack` | `--no-open`, `--credential-stdin` \| `--credential-fd <n>` | No, but channel selection only runs on an attended TTY | `connected` |
| `fireflies` | `--no-open` | **Yes — always** | `credentials_stored_webhook_pending` |
| `granola` | `--workspace-key`, `--credential-stdin` \| `--credential-fd <n>` | No | `connected` |
| `google` | `--no-open` | No (browser sign-in, then polls) | `connected` |

The provider is always a flag. Omitting `--provider`, passing a bare provider
word (`connect slack`), or passing a provider that isn't in the table above,
fails immediately with `invalid_connect_usage` (exit `2`) and prints the exact
list of valid providers — it never falls through to any one provider's
flow by default.

If the provider is already connected, `connect` says so and prints no link:
`{"status":"connected","provider":"linear","message":"Linear is already connected. No link is needed."}`.
A connection that is saved and waiting for its first event answers
`{"status":"pending",...}` the same way.

```bash
draft connections connect --provider github                        # prints install-app guidance, then waits for install
draft connections connect --provider github --no-open --json      # print the install URL instead of opening a browser

draft connections connect --provider linear                        # prompts for a Linear API key on the terminal
echo '{"api_key":"..."}' | draft connections connect --provider linear --credential-stdin --json

draft connections connect --provider claude-code
echo '{"setup_token":"..."}' | draft connections connect --provider claude-code --credential-stdin

draft connections connect --provider slack                         # opens the Slack app-manifest page, then prompts for
                                                           # xoxb-/xapp- tokens, then an interactive channel picker
draft connections connect --provider slack --credential-fd 3 3<tokens.json   # automation mode — channel_ids default to []

draft connections connect --provider fireflies                      # requires an attended terminal end to end

draft connections connect --provider granola                        # prompts for a personal Granola API key
draft connections connect --provider granola --workspace-key         # connects the workspace's shared key instead
echo '{"api_token":"grn_..."}' | draft connections connect --provider granola --credential-stdin --json

draft connections connect --provider google                         # opens Google sign-in, then waits until you finish
draft connections connect --provider google --json                  # prints action_required with the sign-in URL, then connected
draft connections disconnect --provider google                      # disconnects your Gmail and revokes Draft's access at Google
```

**Google** connects only your own Gmail, not the workspace's. Sign-in always
happens in the browser, so it works the same in a terminal and from an agent.
Draft asks only for read-only Gmail access. With `--json`, the CLI first
prints `{"status":"action_required","provider":"google","url":"…"}`, then
`{"status":"connected","provider":"google"}` when you finish. It stops
waiting after 10 minutes. Gmail is read live when your agent asks; nothing is
copied into Draft. After you connect, restart your MCP client (or run `/mcp`
in Claude Code) so the Gmail tools appear.

`github`, `linear`, `claude-code`, `slack`, and `granola` accept
`--credential-stdin` (a single JSON object on stdin) or `--credential-fd <n>`
(the same, on an inherited file descriptor ≥ 3) as an alternative to the
interactive hidden prompt — useful for scripting. **`fireflies` accepts
neither.** Reconnecting Fireflies rotates its webhook secret, invalidating
the one already configured on Fireflies' side, so the flow needs a human to
confirm the rotation, paste the new token, and copy the newly generated
webhook URL/secret out of a local handoff page — none of that can be
scripted, so the CLI requires a real terminal and fails immediately with
`credential_input_required` (exit `2`) if one isn't attached, before making
any network call. Granola has no equivalent manual step — the backend
registers the Granola webhook itself using the API key, so reconnecting
Granola is scriptable end to end.

`--no-open` (github, slack, fireflies) prints the browser/handoff URL instead
of opening it — useful over SSH or in a container. In every case where a
browser or local page can't be opened, the CLI falls back to printing the
URL so you can open it yourself; it never blocks waiting for a browser that
didn't launch.

Every hidden-credential prompt (linear, claude-code, slack, fireflies, granola) prints
where to find the value before asking for it — a settings URL, or for
`slack` which OAuth screen each token comes from — states plainly that the
prompt is hidden (input isn't echoed to the screen), and confirms that
Ctrl+C cancels it. This guidance is written straight to the terminal, not
into the `--json` stdout stream, so it shows up even with `--json` set as
long as the interactive prompt is what's actually running; it's only
skipped entirely when credentials come via `--credential-stdin`/
`--credential-fd` instead.

**GitHub** allows only one active installation per workspace — connecting a
second one while the first is still active fails with
`github_installation_conflict` (exit `1`); disconnect the existing one first.
After the browser opens, the CLI prints what to do there (install the app,
grant repo access), then "Waiting for installation." while it polls for
completion — it resolves to `connected` or an error once you finish the
install in the browser.

**Slack**'s channel picker (during the first `connect --provider slack`, and
during `join` with no `--channel`) only runs when you're at an attended
terminal; scripted/automated runs default to an empty channel selection
(`[]`) at connect, and `join` without `--channel` fails with a usage error
rather than prompting. To change channels after connecting, use `join` and
`leave` below. Slack message capture depends on exactly one backend replica
holding the account's Socket Mode connection at a time — this doesn't affect
the CLI directly, but it's why a fresh `connect`/`join` may take a moment to
show captured activity after a backend deploy.

**Fireflies** ends in `credentials_stored_webhook_pending`, not `connected`
— the CLI stores the token and shows you the webhook details, but can't
verify you actually finished pasting them into Fireflies. It opens (or
prints, with `--no-open`) a local handoff page with the webhook URL and
secret, and both the page and the terminal spell out the Fireflies webhook
  settings URL (`https://app.fireflies.ai/integrations/api/webhook`) and the
two events to enable — Meeting Transcribed and Meeting Summarized. Re-running
`connect fireflies` on an existing connection always warns before rotating
the secret (`y`/`N` at the terminal); declining exits `1` with `cancelled`
and makes no request. See `connections list` above for why the connection
still shows `pending` after this succeeds.

**Granola** requires a Business or Enterprise plan — Granola only issues API
keys, and only allows webhooks, on those plans, so there is no separate
free-tier path. `--workspace-key` connects the workspace's single shared key
(`account_kind: "workspace"`, no owning teammate) instead of the default
personal key (`account_kind: "personal"`, one row per connecting teammate —
reconnecting your own key rotates that row rather than creating a second
one). "Workspace admin" here refers to a *Granola* permission (who can
generate a workspace API key on Granola's side), not a Draft one — any Draft
workspace member can paste a workspace key once they have it. On success the
backend registers a webhook with Granola directly using the key (no
paste-into-Granola-UI step) and backfills the last 7 days of existing notes;
everything after that arrives via the webhook.

### `draft connections disconnect --provider <provider> [--yes] [--json] [--workspace-key]`

Without `--yes` it reports what would stop and changes nothing (exit `1`). Run
it again with `--yes` to disconnect. Only the person who connected a provider
can disconnect it.

```bash
draft connections disconnect --provider github            # prints what would stop, and the command to confirm
draft connections disconnect --provider github --yes
draft connections disconnect --provider linear --yes --json
draft connections disconnect --provider granola --workspace-key --yes   # the workspace key, not your own
```

Supported for `github`, `fireflies`, `linear`, `slack`, `granola` — each
makes a real request and reports `disconnected`. `claude-code` is a
recognized argument (not a grammar error) but always reports `not_supported`
(exit `1`) and makes **no** network call — there's no live Claude Code
credential to revoke server-side.

`--workspace-key` only applies to `granola`, which is the one provider that
can have two live connections at once (your personal key and the workspace
key); it selects which one to disconnect and is rejected as `invalid_usage`
for every other provider. Omitting it disconnects your own personal Granola
connection.

### Slack channels: `join`, `leave`, `read`, `post`

Connect Slack once, then choose its channels one at a time. Each command
takes `--provider slack` and channel ids or `#names`. Names match case-insensitively.

```bash
draft connections list --provider slack --available      # which channels exist, and which the bot is in
draft connections join --provider slack --channel '#eng,#ops'
draft connections leave --provider slack --channel '#eng'
draft connections read --provider slack --channel '#general' --limit 20
draft connections post --provider slack --channel '#standup' --text 'Deploy is done.'
echo 'Deploy is done.' | draft connections post --provider slack --channel '#standup' --text -
```

- **`join` and `leave`** change only the channels you name, and say which
  changed, which were already so, and which failed. They work on public
  channels, and `--channel` takes a comma-separated list. A failure for one
  channel doesn't fail the others; the exit code is `1` when any failed.
  Without `--channel`, `join` in a terminal (and without `--json`) shows the 100
  biggest channels the bot is not in and asks which to join. A script or an
  agent has no terminal, so it must pass `--channel`.
- **`read`** prints recent messages from a channel the bot has joined (`--limit`
  is 1 to 50, default 20). Read before you post.
- **`post`** posts to a channel the bot has joined. Draft adds a line saying
  who sent it. `--text -` reads the message from stdin.

Joining and leaving are for people. A routine can read and post only in the
channels its permissions name.

### Search and read: `search`, `read`

`search` looks in a connected provider and prints one line per result (date,
title, snippet, id). A page that has more ends with a `More:` line holding the
exact command for the next page.

```bash
draft connections search --provider <provider> --query 'quarterly plan' --since 2026-10-01 --limit 10
draft connections search --provider <provider> --query 'quarterly plan' --cursor '<cursor>'
draft connections search --provider <provider> --query 'quarterly plan' --json
```

- **Flags:** `--query` (required), `--since` and `--until` (ISO dates),
  `--limit` (1 to 50, default 20), `--cursor`. Google Drive also takes
  `--file-id` (only inside that file) and `--include-history` (older versions).
- **Providers:** `list` shows which providers can search. Slack has no live
  search. Messages Draft stored are searched with `draft sources search --provider slack`.
- **`read`** takes each provider's own flags: `--channel` and `--limit` for
  Slack; `--message-id`, `--thread-id` and `--attachment-id` for Gmail;
  `--file-id`, `--version`, `--as-of` and `--include versions` for Google Drive.
  `--max-bytes` and `--cursor` page through long text. A provider refuses a
  call that lacks what it needs, and says what it needs.
- **`join` and `leave`** take `--folder <ids>` (comma separated) for a provider
  that syncs folders, in place of `--channel`.
- **Provider names:** use `gmail` and `google-drive` for these commands.
  `connect` takes only the names a provider is connected as: Gmail and Google
  Drive connect together as `--provider google`.

### JSON Lines event vocabulary

`--json` writes one `{"schema_version":1, ...}` object per line to stdout.
A `connect` flow that needs a browser or local handoff prints one or more
progress lines first, then a terminal line:

```json
{"schema_version":1,"status":"browser_required","provider":"github","url":"https://github.com/apps/.../installations/new?state=...","expires_in_seconds":300}
{"schema_version":1,"status":"awaiting_install","provider":"github"}
{"schema_version":1,"status":"connected","provider":"github"}
```

```json
{"schema_version":1,"status":"handoff_required","provider":"fireflies","url":"file:///tmp/draft-fireflies-XXXXXX/index.html","opened":true}
{"schema_version":1,"status":"credentials_stored_webhook_pending","provider":"fireflies"}
```

```json
{"schema_version":1,"status":"awaiting_credentials","provider":"granola"}
{"schema_version":1,"status":"connected","provider":"granola"}
```

`browser_required` is used by `github`/`slack` (a real, remote URL);
`handoff_required` is fireflies-only (a local `file://` page — the webhook
secret is written into that page, never printed to stdout/stderr by the
CLI itself). Granola never emits `browser_required` or `handoff_required` —
the backend registers its webhook itself, so `connect granola` is just
`awaiting_credentials` then a terminal line, same shape as `linear`. A
`connected` event for Linear may also carry `"cleanup_pending":true` if a
prior webhook couldn't be auto-removed during a credential-rotation
reconnect — the new connection is still authoritative and usable; cleanup
retries automatically.

**Error codes worth knowing beyond the general set:** `invalid_connect_usage`
(`connect` called with no provider or an unrecognized one, exit `2`),
`credential_input_required`
(no TTY and no `--credential-stdin`/`--credential-fd`, exit `2`),
`invalid_credential_input` (malformed hidden-input JSON or a token that
fails a provider's own format check, exit `2`), `cancelled` (declined a
confirmation prompt, exit `1`), `workspace_changed` (the signed-in workspace
changed mid-flow, exit `1`), `github_installation_conflict` (exit `1`),
`aborted`/`interrupted` (Ctrl+C, exit `130`).

---

## Installing and updating

The CLI installs standalone — no repo clone, no bun, no desktop app required:

```bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
```

This downloads the platform-matched `draft` binary from the latest GitHub release (the same release `make desktop-release` cuts for the desktop app) to `~/.draft/bin/draft` and links it onto `PATH` — the same layout the desktop app's own first-launch installer uses, so either install path works interchangeably with `draft update`.

### `draft update`

Downloads the latest release binary for your platform and replaces the running `draft` in place.

```bash
draft update            # install the latest version
draft update --check    # report whether an update is available, without installing
draft update --json
```

Every other command also does a cheap, cached, non-blocking staleness check in the background and prints a one-line notice to stderr (`Update available: vX → vY — run draft update`) when a newer release is cached as available — nothing waits on the network to run your actual command. `draft --version` prints the installed version. Not available when running from source (`bun run src/index.ts`) — only applies to a compiled release binary.

### `draft uninstall`

Removes the `draft` binary (`~/.draft/bin/draft`), the `/usr/local/bin/draft` link if it points at that binary, and the `# added by Draft` PATH line from `~/.zprofile`, `~/.bash_profile` and `~/.profile`.

```bash
draft uninstall         # asks for confirmation on the terminal
draft uninstall --yes   # skip the prompt (required with --json or without a terminal)
draft uninstall --json
```

The rest of `~/.draft` stays: your data, `config.json`, and the `bun` and `tmux` copies the desktop app uses. To reinstall, run the install script above or open the desktop app.

---

## Other commands

### `draft completion`

Outputs a shell completion script for `draft` commands.

```bash
draft completion            # bash completion
draft completion --zsh      # zsh completion
```

Follow the printed instructions to install into your shell profile.

---

## Machine-readable output

Every command accepts `--json`. Most `--json` invocations write exactly one JSON object to stdout with `schema_version: 1`. A few stream JSON Lines instead — one object per line, ending with a terminal line: `auth login` (one `pairing_required` line, then one terminal line) and `connections connect --provider github`/`slack`/`fireflies`/`linear`/`granola` (one `browser_required`/`handoff_required` line for github/slack/fireflies, plus `awaiting_install`/`awaiting_credentials` progress lines for some providers, then one terminal line) — see [Hosted connections](#hosted-connections) above. stdout carries JSON only in `--json` mode; human-readable errors go to stderr.

**Exit codes:** `0` success · `1` authentication/API/operational error · `2` invalid usage · `130` interrupted (Ctrl+C — during `auth login`, or during a `connections connect`/`connections join` prompt).

---

## See also

- [Architecture](./architecture.md)
- [Agent plugins](./agent-plugins.md)
- [Connect Draft to your agent](./connect-draft-to-your-agent.md)
