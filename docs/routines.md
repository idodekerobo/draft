# Routines

A routine is a background task that Draft runs on a schedule. You see them on the Routines tab in the web and desktop apps. You can also read them from the CLI and MCP.

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

## Read routines from the CLI

~~~bash
draft routines list [--json]
~~~

Text output shows the title, schedule, cron expression, enabled state, and next run. `--json` prints `{ routines }` with every field, including `cron` and `intervalSeconds`.

## Read routines over MCP

Call `routines.list`. It takes no arguments and returns `{ routines }`. It needs only the read scope.

## Coming next

Custom routines, and changing routines from the CLI and MCP. Today these surfaces only read.
