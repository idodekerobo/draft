# Product analytics

Draft can send product usage events to [PostHog](https://posthog.com). This page lists what is sent, how it is linked to you, and how to turn it off.

## On by default, opt out any time

New accounts start with usage data on, including session replay. You can turn it off in **Settings > Privacy** ("Share usage data"), in the web app or the desktop app. Your choice is stored on your Draft account, so one choice covers both apps. Accounts created before this change keep the choice they had. When usage data is off, the apps send nothing to PostHog.

There is no separate replay switch. Replay runs whenever usage data is on.

Builds without a PostHog key (for example self-hosted and open-source builds) send no analytics at all.

## What is collected

- Screens you view and buttons you press, as coded names (for example `onboarding_step_viewed` with `step: connect_tools`).
- Coded error and status values (for example a failed connection's error code).
- Which app sent the event: every event carries `platform` set to `web`, `desktop` or `landing`.

## What is not collected

- Passwords, API keys and tokens (password-type fields), and the repository and branch fields on the start screen. These fields are excluded from session replay.
- The content of your context, files, messages, meetings or sessions in usage events. Usage events carry coded values only. Session replay is different: see [Session replay](#session-replay).
- File paths and workspace names in usage events.

## How events are linked to you

After you turn usage data on, the web and desktop apps identify events with your Draft account id (a random UUID). This joins your web and desktop use. Your email address is also stored on the PostHog profile, so the Draft team can find an account when it investigates an issue.

When you turn usage data off, the apps stop sending events and reset the PostHog identity in that app.

## Session replay

While usage data is on, PostHog records how you move through the app to help the Draft team understand usage and fix bugs. Text masking is off, so a recording shows the text on screen, such as meeting quotes, names and session text, and the text you type in ordinary fields, including your messages to agents in a session. Password-type fields (API keys and tokens) and the repository and branch fields are excluded. Turn off **Share usage data** in Settings to stop recording.

## Events

Shared by web and desktop (`shared-ui/src/analytics/events.ts`):

| Event | Properties |
|---|---|
| `invite_viewed` | none |
| `account_created` | `method`: `email` or `google` |
| `invite_joined` | none |
| `onboarding_step_viewed` | `step` |
| `onboarding_completed` | `step` where it finished |
| `onboarding_skipped` | `step` where it was skipped |
| `analytics_consent_granted` | none (sent when you turn usage data back on in Settings) |
| `first_tool_connected` | `source` (tool name) |
| `integration_connected`, `integration_disconnected`, `integration_channels_updated` | `source` (tool name) |

The desktop app also sends app events such as `app_launched`, `view_navigated`, `context_doc_viewed` and update and install results. The full list is the typed union in `apps/desktop/src/app/analytics/events.ts`. Properties follow the same rule: coded values only.

Events sent before you turn usage data on are kept in memory in the open tab and sent only if you turn it on in that tab. Otherwise they are dropped.

## Landing page

The marketing site (`apps/landing-page`) records page views and, when enabled, session replay without masking form input. It does not ask for consent yet; a consent banner is planned.

## Withdraw or delete

- Turn off **Share usage data** in Settings in either app. This stops future events.
- To delete events already sent, contact the Draft team through **Questions & Feedback** in the desktop app with the email on your Draft account. A self-serve delete action is planned.

## Agent calls and routines

Draft keeps operational call and execution records in its database separately from optional PostHog analytics. External CLI/MCP tool invocations reaching the gateway are recorded with surface, outcome, elapsed time and response size. Direct app calls are excluded. Calls made inside a Draft-managed run remain linked to that run. Older query records and legacy routes can have unknown outcomes.

Web and desktop send `routine_setup_started` when the creation form opens, and `routine_result_viewed` with `live_session_id` when an ended routine session is viewed, including one that finishes while open. These events use the existing Share usage data setting.

The backend sends `routine_created`, `routine_updated`, `routine_deleted`, `routine_run_requested` and `routine_run_completed`. These carry coded metadata and applicable workspace/routine/run/session IDs, call surface, harness, runtime, start reason and outcome. They contain no prompts, routine titles, message content, credentials or document bodies. Occurrence identifiers let analysis deduplicate lifecycle events.

Backend events require an attributed user whose Share usage data setting is currently enabled. Shared work with no attributed user remains in the operational database and is not assigned to a random PostHog identity. Missing configuration and analytics failures do not fail customer work; event delivery is best effort and is not a billing ledger.

Hosted backend configuration accepts `POSTHOG_KEY` and `POSTHOG_HOST` (or the existing `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST`). Use the same project as the apps to join user UUIDs and workspace IDs. No key disables backend capture. Self-hosters can leave it unset.

Routine creation records one `created_via` value: `web_app`, `desktop_app`, `cli`, `mcp`, `run` or `system`. Historical `app` records retain their unknown app surface. CLI/MCP usage alone does not distinguish a human from an external agent. PostHog’s existing `platform` property remains a separate marketing/app SDK property.
