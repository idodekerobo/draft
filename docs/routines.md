# Routines

A routine is work Draft runs for your team: on a schedule, when something happens in a connected tool, or when someone presses Run now. Draft comes with built-in routines, and you can add your own, where an agent follows your instructions. You see them on the Routines tab in the web and desktop apps, and you can manage them from the CLI and MCP.

## Built-in routines

| Routine | What it does | What you can change |
| --- | --- | --- |
| Update company context | Checks for new source material and updates the company context. If nothing is new, no synthesis run starts. | Schedule and on/off |
| Summarize coding sessions | Turns newly captured coding sessions into summaries. Sessions already summarized are skipped. | Schedule and on/off |
| Sync Slack | Imports new messages from the connected Slack channels. Pick the channels in Connections. | On/off only |

## Schedules and timezone

Editable routines use a preset: Draft default, hourly, daily, weekdays, or weekly. Daily, weekdays, and weekly presets take a time. Weekly takes a weekday. Every schedule runs in the routine's timezone. Slack sync runs on a fixed interval, so it has no cron expression.

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

A routine can start on its schedule, when something happens in a connected tool, or when someone runs it. If a trigger needs a provider you haven't connected, Draft says so and how to connect it. See the [CLI reference](./cli.md#routines) and [MCP and agent connections](./mcp.md#routines) for every option.
