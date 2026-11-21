# MCP and agent connections

Draft exposes the company brain to MCP-compatible agents through a remote, OAuth-protected HTTP server. The hosted endpoint is:

~~~text
https://api.draftai.us/mcp
~~~

Sign-in asks for the `read` and `write` OAuth scopes. Your agent works in your team's workspace, with your access. Tools that only read are marked read-only, and `routines.delete` is marked destructive, so your agent can ask you before deleting anything.

## Tools

### Context and sources

| Tool | Purpose |
| --- | --- |
| `context.list` | List the workspace's available context dimensions. |
| `context.read` | Read one or more dimensions, or all current workspace documents. Pass `period` (with `dimensions: ["memory"]`) to read one day/week/month document from the chronological memory log instead of the whole thing. |
| `context.export` | Return a download link to the full context as a zip of markdown files, plus the commands to fetch and unzip it. The link expires after 5 minutes and stops working if the user loses workspace access. The file bytes skip the model's context window, so prefer this over `context.read` when the user wants files on disk. |
| `sessions.list` | `{ provider?, since?, until?, limit?, cursor? }` — list interactive Draft app conversations newest first. `provider` is the harness id, such as `codex`; continue with `next_cursor`. |
| `sessions.read` | `{ session_id, after_seq?, limit? }` — read a Draft app session and a page of its events. Continue with `next_after_seq`. |
| `sources.list` | `{ provider?, type?, since?, until?, limit?, cursor? }` — browse active ingested source items without a content query. Use `type: ["coding_session"]` to list captured coding sessions; continue with `next_cursor`. |
| `sources.search` | Full-text search across stored source items (Slack, GitHub, meetings, captured coding sessions). Filter by provider, type and date. |
| `sources.read` | Read one source item by ID, in the default or another captured representation. `structured` returns the provider's own fields. |

### Routines

A routine is work Draft runs once, on a repeating schedule, on events (such as a merged pull request or a new Linear issue), or when someone presses Run now. See [Routines](./routines.md) for how these appear in the app.

| Tool | Input | Purpose |
| --- | --- | --- |
| `routines.options` | `{}` | Available triggers and provider connections, schedule presets, agents, Slack channels and GitHub repos. Call it before `create` or `update` from your MCP client. |
| `routines.list` | `{ taskId?, kind?, status?, createdBy? }` | Routines with full settings, or one by `taskId`. `kind` is `once`, `recurring` or `event`; `status` is `upcoming` or `fired`; `createdBy` is `me` or `anyone`. One-time routines are hidden from the default list. |
| `routines.create` | `{ title, prompt, harness, when, ... }` | Create a routine and return the saved routine. `harness` is required for a person; a routine run can inherit it from its parent. |
| `routines.update` | `{ taskId, patch }` | Change only the supplied fields. Timing and triggers go under `patch.when`. `postChannels: null` and `github: null` remove that access. |
| `routines.delete` | `{ taskId }` | Delete a routine, including cancelling a pending one-time routine. Destructive: confirm with the person first. |
| `routines.run` | `{ taskId }` | Request an immediate run, including on paused routines and one-time routines that already fired. Returns `sessionId` when started, or `queued: true` and `sessionId: null` when queued behind active work. |
| `routines.runs` | `{ taskId, cursor?, sessionId?, transcript? }` | Runs, newest first, 50 at a time: status, what started it, result and skip reason. Pass `nextCursor` as `cursor` for older runs. With `sessionId`, return one run; add `transcript: true` for its transcript, using the transcript's own `nextCursor` for more. |

#### Set timing with `when`

`when` takes one of these shapes:

| Shape | Example | Meaning |
| --- | --- | --- |
| Delay | `{"in":"2h"}` | Run once after a positive whole number of minutes, hours or days (`m`, `h`, `d`). |
| Timestamp | `{"at":"2026-12-01T09:00:00-05:00"}` | Run once at an ISO timestamp with a timezone offset. |
| Preset schedule | `{"schedule":{"preset":"daily","time":"09:00","timezone":"America/New_York"}}` | Repeat on a preset schedule. |
| Custom schedule | `{"schedule":{"cron":"0 9 * * 1-5","timezone":"America/New_York"}}` | Repeat using a cron expression and timezone. |
| Events only | `{"schedule":null,"events":["linear.issue_created"]}` | Run on events, without a repeating schedule. |
| Schedule and events | `{"schedule":{"preset":"hourly"},"events":["linear.issue_created"]}` | Run on either the schedule or matching events. |

One-time runs must be in the future, at most 365 days away. A one-time `when` cannot include a schedule or events. On update, a rule's omitted `schedule` or `events` is unchanged. Send a complete schedule object to change it; use `when.schedule: null` to turn it off, or `when.events: []` to remove triggers. `enabled: false` pauses automatic runs. A fired one-time routine needs a new `when` time to be scheduled again.

For example, call `routines.create` with:

~~~json
{
  "title": "Check PR",
  "prompt": "Check the review status of acme/api PR #42 and report remaining blockers.",
  "harness": "claude",
  "when": {"in": "2h"}
}
~~~

To reschedule it, call `routines.update` with:

~~~json
{"taskId":"<routine id>","patch":{"when":{"in":"2h"}}}
~~~

To list your pending one-time routines, call `routines.list` with `{"kind":"once","status":"upcoming","createdBy":"me"}`. Returned routines include `kind`, `runAt`, `firedAt`, `madeByAgent`, `createdByRunId` and `visibility`. `missingConnections` names triggers or access that cannot work until their provider is connected.

The old top-level schedule fields are no longer accepted. Send timing in `when`; update older CLI or desktop clients before creating or editing routines.

#### Follow-ups from routine runs

Routine runs can call `routines.create`, `update`, `delete`, `list`, `run` and `runs` under their granted permissions. `routines.options` is for people and their MCP clients. A child belongs to the parent run's person and inherits omitted settings from its parent routine; model and reasoning effort are inherited only when the harness matches. The prompt must be self-contained because the future run cannot see the scheduling conversation.

Runs cannot grant wider access, change routines outside their permitted descendant chain, or start their own routine again. Limits include five creates and five Run now requests per run, three levels of nesting, at least an hour between repeats for schedules made by runs, and a cap of 20 pending one-time routines made through MCP or routine runs when a run creates another. The hourly rule limits frequency, not run duration; it does not apply to one-time delays or schedules people create.

`create` and `update` refuse settings that cannot work yet, and explain why:

| Code | Meaning |
| --- | --- |
| `<provider>_not_connected` | A trigger or access needs a provider the workspace hasn't connected, for example `linear_not_connected`. Offer to connect it with `connections.connect`. |
| `claude_not_connected`, `codex_not_connected` | That agent isn't connected for routines in this workspace. |
| `claude_needs_reconnect`, `codex_needs_reconnect` | That agent's routine login needs reconnecting. |
| `too_far_ahead`, `in_the_past` | Choose a future one-time date within 365 days. |
| `depth_limit`, `limit_reached`, `too_many_pending`, `too_frequent` | A routine run reached a follow-up limit. |
| `no_owner`, `not_permitted` | The run has no person to act for, or lacks permission for that operation. |

A routine runs as the person who created it. A run started by an event only sees that event's source if its creator can see it; otherwise the run is recorded as skipped, with a reason. Private routines are hidden from other people, including reads and changes by ID.

To follow a started run, call `routines.runs` with its returned `sessionId` until its status is no longer `running`. A queued response has no session ID yet; check the routine's runs for the new run after active work ends.

### Activity

| Tool | Input | Purpose |
| --- | --- | --- |
| `activity.list` | `{ cursor? }` | Everything the workspace's agents have run, newest first, 50 at a time: routine runs, context updates, session summaries and interactive sessions, with status, timing and result. Pass the returned `nextCursor` as `cursor` for older runs. This is the same list as the Activity page. The first page also has `upcoming`: pending one-time routines ordered by their scheduled time, with who set each one. If that read fails, past runs still return with `upcomingError: true`. |

Run rows include `routineKind` (`once`, `rule` or `null`) and `createdRoutines`, the visible routines each run created. An Upcoming item includes `id`, `title`, `runAt`, `timezone` and `setBy`, which identifies a person or parent routine. Later pages omit Upcoming.

### Connections

| Tool | Input | Purpose |
| --- | --- | --- |
| `connections.list` | `{ provider? }` | Every provider (GitHub, Slack, Linear, Fireflies, Granola, Claude Code): `connected`, `pending` (saved, waiting for its first event), `needs_reconnect` or `not_connected`; what it brings in; which routine triggers and abilities it unlocks; how to connect it; and `actions`, the verbs you may call on it with their fields. For Slack, `channels` lists the channels the bot has joined. |
| `connections.connect` | `{ provider, channels? }` | Start connecting a provider. Answers `{ status: "action_required", url, expiresAt }`. Your agent gives you the link, and you sign in or enter the key on that page in the Draft app. The link works once, only for you, for 15 minutes. Answers `{ status: "connected", message }` with no link if it already is, and `{ status: "pending", message }` if it is saved and waiting for its first event. For Slack, once connected, pass `channels` (ids or `#names`) to change which public channels the bot joins. |
| `connections.disconnect` | `{ provider, accountKind?, confirm? }` | Disconnect a provider you connected. Without `confirm` it answers `{ status: "confirmation_required", stops, message }` and changes nothing. With `confirm: true` it disconnects. |
| `connections.read` | `{ provider, channel, limit? }` | Read recent messages from a connected provider. Slack today: a channel id or `#name` the bot has joined. |
| `connections.post` | `{ provider, channel, text }` | Post a message through a connected provider. Slack today. Draft adds an attribution line. |

Your agent never sees your keys: you enter them on the Draft page the link opens. Every refusal names what would have worked, such as the channels the bot has joined.

### Skills and people

| Tool | Purpose |
| --- | --- |
| `skills.list`, `skills.read` | List and read shared workspace skills. |
| `skills.add` | Create a new shared skill. Fails with `duplicate_name` if the name exists. |
| `skills.update` | Replace an existing skill's content and fields. Fails with `skill_not_found` if the name does not exist. |
| `skills.delete` | Remove a skill from the workspace. A client asks before it runs, because the tool is marked destructive. Fails with `skill_not_found` if the name does not exist. |
| `people.find`, `people.create`, `people.add_identity`, `people.notify`, `people.approve`, `people.reject` | Find the workspace's people, add people and their identities, and message a teammate. |

## Connect Claude Code

Register Draft as a remote HTTP MCP server:

~~~bash
claude mcp add --transport http draft https://api.draftai.us/mcp
~~~

Start or restart a Claude Code session. When Claude Code connects for the first time, follow Draft's browser sign-in and consent flow. You can check the connection with `claude mcp list`.

## Connect Codex

Add Draft to the Codex MCP configuration at `~/.codex/config.toml`:

~~~toml
[mcp_servers.draft]
url = "https://api.draftai.us/mcp"
~~~

Start or restart Codex and complete the browser sign-in and consent flow when prompted by the MCP client.

## Use the CLI instead

The CLI reaches the same company brain through authenticated API calls. It is useful for scripts, setup, project instructions, and explicit reads:

~~~bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
draft auth login
draft context read --all
draft skills list
~~~

List app sessions and captured source evidence separately:

~~~bash
draft sessions list --provider codex
draft sources list --type coding_session
draft sources search "database migration" --type coding_session
draft sources read <source_item_id> --representation transcript
~~~

Session listing and reading are user-scoped MCP tools. Source list/search/read are available to signed-in users and, subject to run permissions, agent runs. Capture setup remains an explicit CLI operation because it installs a local repository hook; there is no MCP capture-write tool.

To make Draft discoverable from a project instruction file:

~~~bash
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
~~~

`draft add` writes a small managed block to `CLAUDE.md` or `AGENTS.md`; it does not copy the company brain into the repository. Use `draft sources capture enable claude-code --dir ...` separately when the repository should capture completed Claude Code sessions.

## Self-hosted deployments

Use the same `/mcp` path on the API base URL for a self-hosted deployment:

~~~text
https://api.example.com/mcp
~~~

The deployment must have its Better Auth MCP/OAuth configuration enabled, and the agent, CLI, web app, and desktop app should all point to the same Draft deployment. Configure the CLI with `DRAFT_API_BASE_URL`, `DRAFT_APP_URL`, `DRAFT_SUPABASE_URL`, and `DRAFT_SUPABASE_PUBLISHABLE_KEY` as described in the [CLI reference](./cli.md#configuration).

## See also

- [Connect Draft to your agent](./connect-draft-to-your-agent.md)
- [CLI reference](./cli.md)
