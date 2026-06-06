# Privacy

Draft is a local-first tool. Your context files, agent conversations, and code never leave your machine. This page describes what data Draft does and does not collect, and how analytics work.

---

## What stays on your machine

Everything in `~/.draft/` is local only and never transmitted to Draft servers:

- All workspace context files (`company`, `product`, `team`, `priorities`, `decisions`)
- Personal memory and preferences
- Proposals, accepted changes, rejected changes
- Integration credentials (Granola API token, Slack tokens, GitHub auth)
- Daemon logs
- Config and settings

Your prompts and conversations with Claude Code, Codex, or Cursor are also never seen by Draft. Draft only reads session transcripts after a session ends, locally, to run synthesis — and only the output of that synthesis (a structured proposal) is ever written to disk.

---

## Analytics

During onboarding you're asked whether to share anonymous usage data. **This is opt-in.** If you decline, no data of any kind is sent. You can change this at any time in **Settings → Privacy**.

### What we collect (if opted in)

Analytics are strictly limited to behavioral signals about how the app is used. We never collect content.

| Event | What's included |
|-------|----------------|
| App launched | User state (first-run, setup-incomplete, ready) |
| Onboarding step viewed | Step name |
| Onboarding completed | Which tools were selected (e.g. "claude-code") |
| Onboarding abandoned | Last step reached |
| View navigated | View name (context, proposals, settings) |
| Proposal actioned | Action (accepted/rejected) and source (e.g. "claude-code-session") |
| Daemon start attempted | — |
| Daemon start succeeded | Time to start (milliseconds) |
| Daemon start failed | Error code only (not message) |
| Integration connected/disconnected | Source name (granola, slack, github) |
| Tool installed | Tool name |
| Tool install failed | Tool name and step label |
| Context section toggled | Section name, enabled/disabled |
| Context doc viewed | File kind and dimension group |
| Context doc expanded | Dimension group |
| Analytics consent granted | — |
| Daemon started | — |
| Daemon synthesis completed | Source type |
| Daemon synthesis failed | Source type |
| Daemon daily alive ping | — |

### What we never collect

- Prompts, messages, or agent responses
- Content of any context file
- File names, file paths, or directory names
- Workspace names or profile names
- Any user-entered text of any kind
- Integration data (meeting notes, Slack messages, GitHub activity)
- Your email, name, or any identifier tied to your identity

### Identity

Analytics use a stable anonymous UUID generated locally on first launch and stored in `~/.draft/config.json`. This UUID is never linked to an email, name, IP address, or any other identifier. It exists only to aggregate usage signals across sessions for the same installation.

### Session recording (optional)

If you opt into session recording in **Settings → Privacy → Session Replay**, Draft may record UI interactions in the desktop app to help diagnose usability issues. Session recording is:

- Opt-in separately from basic analytics — analytics consent alone does not enable it
- Fully masked: all visible text in the UI is replaced with `*` before transmission, and all inputs are masked. The recording captures layout and interaction patterns only, never readable content.

---

## Integrations

When you connect Granola, Slack, or GitHub, Draft reads data from those services to generate context proposals. This data:

- Is processed locally — the poller scripts run on your machine and call those services' APIs directly
- Is never stored on Draft servers
- Is never transmitted to Draft servers
- Is never shared with third parties

The only thing that leaves your machine as a result of integration activity is the synthesis call to Claude (using your own API key or subscription) and the resulting proposal file written to `~/.draft/workspaces/<profile>/proposals/`.

---

## Team collaboration

If you set up team context sharing (`/draft:setup-collab`), your accepted proposals are pushed to a GitHub repository **you control**. Draft has no access to this repository. It uses your authenticated `gh` CLI credentials to read and write directly — Draft's servers are not in the loop.

Your teammates pull from the same repo using their own credentials.

---

## Changes to this policy

> TODO: Add link to versioned policy and contact email once legal review is complete.

---

## See also

- [What is Draft](./overview.md)
- [Setting up collaboration](./setting-up-collaboration.md)
