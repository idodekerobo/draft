# Routines

A routine is work Draft runs for your team: once at a chosen time, on a repeating schedule, when something happens in a connected tool, or when someone presses Run now. Draft comes with built-in routines, and you can add your own, where an agent follows your instructions.

Repeating and event routines appear on the Routines tab in the web and desktop apps. One-time routines appear under Upcoming in Activity. You can manage both kinds from the CLI or an agent connected to Draft's MCP server.

## Built-in routines

| Routine | What it does | What you can change |
| --- | --- | --- |
| Update company context | Checks for new source material and updates the company context. If nothing is new, no synthesis run starts. | Prompt, agent, model, reasoning, schedule and on/off |
| Summarize coding sessions | Turns newly captured coding sessions into summaries. Sessions already summarized are skipped. | Prompt, agent, model, reasoning, schedule and on/off |
| Sync Slack | Imports new messages from the connected Slack channels. Pick the channels in Connections. | On/off only |

The prompt and agent settings for Update company context and Summarize coding sessions apply to the entire team. Edit them in the same composer used for other routines. Draft keeps the required inputs, tool permissions and output formats; the prompt controls what the agent should focus on. These routines retain their scheduled job behavior and cannot be deleted or given event triggers.

Defaults live in code and are saved in `scheduled_tasks.config_json` when a built-in routine is registered. Existing tasks without saved settings show the defaults and save them on their first run or edit. Registration never overwrites customized settings. The one-time data migration `20261123182812_backfill_builtin_routine_agent_settings.sql` fills missing settings on existing active tasks without changing schedules, paused states or saved customizations.

Each run snapshots its prompt, harness, model and reasoning in its `AgentRunSpec`. Both built-in routines and custom routines use the shared credential-aware sandbox launcher, which derives tools and the execution environment from that spec. Claude Code and Codex support the built-in routines' structured results, including batches of captured sessions. Synthesis has context read/write and all people tools, including approve, reject and notification to active teammates, without a default people-tool call cap. Summarization has no Draft-tool permissions. Codex uses the team's connected login and the same credential lease as other routines; refreshed logins are saved before the lease is released. Edits affect future runs, including automatic and on-demand context updates, and do not change runs already in progress.

## Run something once

Create a one-time routine from the CLI, through MCP, or by asking an agent to schedule a follow-up:

~~~bash
draft routines create --title "Check PR" --prompt "Check the review status of acme/api PR #42 and report any remaining blockers." --harness claude --in 2h
~~~

Use `--in` for a delay such as `10m`, `2h` or `3d`, or `--at` for an ISO timestamp with a timezone offset. The time must be in the future and at most 365 days away. One-time routines have no repeating schedule or event triggers.

In Activity:

- **Upcoming** lists pending one-time routines, soonest first, with who or which routine set them. Cancel stops a pending routine and removes it from Upcoming.
- After it fires, its run appears under **Runs**. Open run shows what happened; Run again requests another run immediately. If work for that routine is already running, the new run is queued until it ends.
- To schedule another future check after a one-time routine has fired, give it a new time with `draft routines update <id> --in 2h` or `--at`. Run again does not repeat the original delay.

The Routines editor creates repeating and event routines. To find one-time routines in the CLI, use `draft routines list --once`, `--upcoming` or `--fired`; they are hidden from the default list.

## Schedules, events and timezone

Editable repeating routines use a preset: Draft default, hourly, daily, weekdays, or weekly. Daily, weekdays, and weekly presets take a time. Weekly takes a weekday. Every schedule runs in the routine's timezone. MCP also accepts a custom cron expression with its timezone. For a one-time `--at`, the timestamp's offset determines the instant. Slack sync runs on a fixed interval, so it has no cron expression.

A routine can combine a repeating schedule with event triggers, such as a pull request being merged or a Linear issue being created. Turning the schedule off leaves event triggers active; pausing the routine stops its automatic runs. Run now still works on a paused routine or a one-time routine that already fired. If a trigger needs a provider you haven't connected, Draft explains how to connect it.

Draft saves incoming events before starting their work. Repeated delivery of the same provider event is deduplicated, and events for the same subject that arrive while its run is active can be combined into a later run.

## Follow-ups made by an agent

A routine run can schedule a follow-up or create a repeating or event routine on your behalf. The new routine belongs to the same person. Settings it leaves out come from the parent routine; it cannot grant itself wider notification, Slack or GitHub access. Instructions must be self-contained: the future run cannot see the conversation that scheduled it.

Activity shows a **Created** line under the run that made the routine. A pending one-time follow-up opens its Upcoming row; after it runs, the link opens its latest run. A repeating or event routine opens its Routines details. The Routines tab also marks these with **Made by an agent**, linked to the creating run when available.

Routine runs have limits to prevent repeated follow-ups from running without a bound:

- Up to five routines created and five Run now requests per run; a run cannot start its own routine again.
- At most three levels of routines creating further routines.
- Repeating schedules created by runs can run at most once an hour. This limits repetition frequency, not how long a run can take. It does not prevent a one-time check a few minutes away or limit schedules you create yourself.
- A run cannot add a one-time routine when the workspace already has 20 pending one-time routines made through MCP or routine runs.

A run can change or delete only routines in its permitted descendant chain. Other people cannot list or manage a private routine, or read its run history by routine ID. Private follow-ups stay private.

## Last ran and last checked

- **Last ran** applies to "Update company context". It is the time the last synthesis run finished.
- **Last checked** applies to the other routines. They record that Draft looked for work, not that a run happened.

## Manage routines from the CLI or your agent

You can create, change, run and read routines from the CLI, or let an agent connected to Draft's MCP server do it for you. Each CLI command matches one MCP tool:

| CLI | MCP tool |
| --- | --- |
| `draft routines options` | `routines.options` |
| `draft routines list [<id>]` | `routines.list` |
| `draft routines create …` | `routines.create` |
| `draft routines update <id> …` | `routines.update` |
| `draft routines delete <id>` | `routines.delete` |
| `draft routines run <id>` | `routines.run` |
| `draft routines runs <id>` | `routines.runs` |

Add `--mine` to a CLI list to show only routines you created. See the [CLI reference](./cli.md#routines) and [MCP and agent connections](./mcp.md#routines) for every option.
