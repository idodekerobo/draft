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
| `sources.search` | Full-text search across stored source items (Slack, GitHub, meetings, coding sessions). Filter by provider, type and date. |
| `sources.read` | Read one source item by ID, in the default or another captured representation. `structured` returns the provider's own fields. |

### Routines

A routine is an agent that runs on a schedule, when something happens (a meeting is summarized, a pull request is merged, a Linear issue is created), or when someone presses Run now. See [Routines](./routines.md).

| Tool | Input | Purpose |
| --- | --- | --- |
| `routines.options` | `{}` | What a routine can be set to: triggers and whether each one's provider is connected, schedule presets, agents and whether each can run, Slack channels and GitHub repos. Call it before `create` or `update`. |
| `routines.list` | `{ taskId? }` | Every routine with its full settings (instructions, agent, schedule, triggers, Slack and GitHub access, last run), or one routine with `taskId`. `missingConnections` names a trigger or access that can't work until its provider is connected. |
| `routines.create` | the routine | Create a routine. Answers with the saved routine. |
| `routines.update` | `{ taskId, patch }` | Change only the fields in `patch`; schedule fields are flat. `null` turns Slack posting or GitHub access off; `events: []` removes every trigger; `onSchedule: false` runs it only on triggers and Run now. Answers with the saved routine. |
| `routines.delete` | `{ taskId }` | Delete a routine. Destructive: confirm with the person first. |
| `routines.run` | `{ taskId }` | Start a run now. Answers with `runId`. |
| `routines.runs` | `{ taskId, runId?, transcript?, cursor? }` | The newest runs: status, what started it (schedule, Run now or an event), result, and why a skipped run was skipped. With `runId`, one run. Add `transcript: true` for what the agent did, a page at a time; pass the returned `nextCursor` for the next page. |

`create` and `update` refuse a setting that can't work yet, and say why:

| Code | Meaning |
| --- | --- |
| `<provider>_not_connected` | A trigger or access needs a provider the workspace hasn't connected, for example `linear_not_connected`. Your agent can offer to connect it with `integrations.connect`. |
| `claude_not_connected`, `codex_not_connected` | That agent isn't connected for routines in this workspace, so the routine couldn't run. |
| `claude_needs_reconnect`, `codex_needs_reconnect` | That agent's login for routines stopped working. |

A routine runs as the person who created it. A run started by an event only sees that event's source if its creator can see it. Otherwise the run is recorded as skipped, with the reason.

To follow a run, call `routines.runs` with its `runId` until the status is no longer `running`.

### Connections

| Tool | Input | Purpose |
| --- | --- | --- |
| `integrations.list` | `{}` | Every provider (GitHub, Slack, Linear, Fireflies, Granola, Claude Code): `connected`, `pending` (saved, waiting for its first event), `needs_reconnect` or `not_connected`; what it brings in; which routine triggers and abilities it unlocks; and how to connect it. |
| `integrations.connect` | `{ provider }` | Start connecting a provider. Answers `{ status: "action_required", url, expiresAt }`. Your agent gives you the link, and you sign in or enter the key on that page in the Draft app. The link works once, only for you, for 15 minutes. Answers `{ status: "connected" }` if it already is. |

Your agent never sees your keys: you enter them on the Draft page the link opens. To disconnect a provider, use the Draft app or `draft integrations disconnect`.

### Skills, people and Slack

| Tool | Purpose |
| --- | --- |
| `skills.list`, `skills.read` | List and read shared workspace skills. |
| `skills.add` | Create a new shared skill. Fails with `duplicate_name` if the name exists. |
| `people.find`, `people.create`, `people.add_identity`, `people.notify`, `people.approve`, `people.reject` | Find the workspace's people, add people and their identities, and message a teammate. |
| `slack.list_channels`, `slack.read_channel`, `slack.post_message` | List the channels Draft's bot is in, read one, and post to one. |

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

To make Draft discoverable from a project instruction file:

~~~bash
draft add claude-code --dir /path/to/project
draft add codex --dir /path/to/project
~~~

`draft add` writes a small managed block to `CLAUDE.md` or `AGENTS.md`; it does not copy the company brain into the repository. Use `draft sessions enable claude-code --dir ...` separately when the project should capture completed Claude Code sessions.

## Self-hosted deployments

Use the same `/mcp` path on the API base URL for a self-hosted deployment:

~~~text
https://api.example.com/mcp
~~~

The deployment must have its Better Auth MCP/OAuth configuration enabled, and the agent, CLI, web app, and desktop app should all point to the same Draft deployment. Configure the CLI with `DRAFT_API_BASE_URL`, `DRAFT_APP_URL`, `DRAFT_SUPABASE_URL`, and `DRAFT_SUPABASE_PUBLISHABLE_KEY` as described in the [CLI reference](./cli.md#configuration).

## See also

- [Connect Draft to your agent](./connect-draft-to-your-agent.md)
- [CLI reference](./cli.md)
