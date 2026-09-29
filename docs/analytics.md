# Product analytics

Draft can send product usage events to [PostHog](https://posthog.com). This page lists what is sent, how it is linked to you, and how to turn it off.

## Off by default

Usage data is off until you turn it on. You can turn it on in the last onboarding screen ("Share usage data") or in **Settings > Privacy**, in the web app or the desktop app. Your choice is stored on your Draft account, so one choice covers both apps. Until you turn it on, the apps send nothing to PostHog.

Session replay is a separate switch in **Settings > Privacy**. It is off by default and can only be on while usage data is on.

Builds without a PostHog key (for example self-hosted and open-source builds) send no analytics at all.

## What is collected

- Screens you view and buttons you press, as coded names (for example `onboarding_step_viewed` with `step: connect_tools`).
- Coded error and status values (for example a failed connection's error code).
- Which app sent the event: every event carries `platform` set to `web`, `desktop` or `landing`.

## What is not collected

- Anything you type, including API keys and search text.
- The content of your context, files, messages, meetings or sessions.
- File paths, workspace names, profile names, and your name or email.

## How events are linked to you

After you turn usage data on, the web and desktop apps identify events with your Draft account id (a random UUID). This joins your web and desktop use. It is pseudonymous: it is not your name or email, but Draft can map it to your account. The desktop background process reports a few health events (`daemon_started`, `daemon_daily_alive`, `daemon_synthesis_completed`, `daemon_synthesis_failed`) with a random per-device id instead.

When you turn usage data off, the apps stop sending events and reset the PostHog identity in that app.

## Session replay

When replay is on, PostHog records how you move through the app to help fix bugs. All text and all inputs are masked, so the recording shows layout and clicks, not content.

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
| `analytics_consent_granted` | none |
| `first_tool_connected` | `source` (tool name) |
| `integration_connected`, `integration_disconnected`, `integration_channels_updated` | `source` (tool name) |

The desktop app also sends app events such as `app_launched`, `view_navigated`, `context_doc_viewed` and update and install results. The full list is the typed union in `apps/desktop/src/app/analytics/events.ts`. Properties follow the same rule: coded values only.

Events sent before you turn usage data on are kept in memory in the open tab and sent only if you turn it on in that tab. Otherwise they are dropped.

## Landing page

The marketing site (`apps/landing-page`) records page views and, when enabled, session replay with all inputs masked. It does not ask for consent yet; a consent banner is planned.

## Withdraw or delete

- Turn off **Share usage data** in Settings in either app. This stops future events.
- To delete events already sent, contact the Draft team through **Questions & Feedback** in the desktop app with the email on your Draft account. A self-serve delete action is planned.
