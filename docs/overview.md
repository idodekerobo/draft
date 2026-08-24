# What is Draft?

Draft is the company brain for teams building with AI.

It turns decisions, product context, priorities, and activity from the tools your team already uses into a shared workspace. Connected agents can use that workspace so sessions start with the same understanding of the company instead of a private, stale copy of context.

You can use the hosted service at [draftai.us](https://draftai.us), or run the open-source stack in infrastructure you control.

## The product model

Draft has a server-side workspace and local clients:

**The workspace** is the canonical company brain. It contains versioned context, source items, synthesis runs, connected-source state, and coding-agent session data. The Draft API authenticates access and enforces organization, team, and workspace boundaries.

**The local clients** are the Electrobun desktop app, the CLI, the local background daemon, and agent integrations. They sign in, display or query the workspace, connect the workspace's hosted data sources (Slack, GitHub, Linear, Fireflies, Claude Code — from either the desktop app or `draft integrations connect` in the CLI), connect local agents, and upload local coding-agent sessions when capture is enabled. The background daemon remains a local/transitional runtime used by desktop bundles and current plugin hooks; it is not the canonical hosted workspace.

The CLI and plugin are the current agent connection path. That surface is intentionally evolving while the project works out the best long-term way for agents to attach to the company brain.

## How information flows

~~~text
Slack · GitHub · Fireflies · Linear · coding-agent sessions
                         |
                         v
         Draft API and ingestion workers
                         |
                         v
        Source items and workspace context
                         |
                         v
       Scheduled synthesis in Fly Machines
                         |
                         v
          New context version in the workspace
                         |
                         v
      Web app · desktop · CLI · connected agents
~~~

Connected sources can arrive through provider webhooks, provider APIs, or a local upload. The backend normalizes the input, schedules synthesis, runs bounded model work in a disposable sandbox, validates the result, and stores a new context version. Humans and clients can then inspect the current workspace.

## Hosted Draft

Hosted Draft provides the web app, API, Supabase project, and Fly sandbox infrastructure for you. Sign up at [draftai.us](https://draftai.us), download the desktop app, sign in, and create or join a team workspace.

## Self-hosting

The open-source stack is self-hostable with:

- Supabase for auth, Postgres, storage, and row-level access control.
- A Bun backend for the API, ingestion, scheduling, and webhooks.
- Fly Machines for isolated synthesis runs.
- The Next.js web app for browser signup, invites, and pairing.
- The Electrobun desktop app configured for your URLs.
- The Bun CLI configured for your API and Supabase project.

Self-hosting currently requires deploying and configuring these services separately. See the root README and the individual app READMEs for the current environment variables and local launcher.

The Makefile does provide one-command local workflows: `make run-local` starts the local app stack, while `make dev-refresh` rebuilds and installs the local CLI, daemon binary, and bundled background runtimes. Those commands are development/runtime refresh commands, not a complete production deployment.

## What is local?

The local machine holds authentication state, project configuration, hook files, temporary capture data, desktop/CLI runtime files, and—when enabled—the local background daemon and its runtime state. When coding-session capture is enabled, a project hook reads the completed local transcript and sends it to the configured Draft API.

The local machine is not the authoritative home of the shared company brain. In hosted mode, the canonical workspace is stored by Draft's deployment. In self-hosted mode, it is stored by the operator's deployment.

## What is server-side?

The deployment stores and serves authenticated workspace context, source items, synthesis runs, coding-agent session records, and the credentials required to connect configured providers. Synthesis executes in sandboxed Fly Machines rather than inside the long-running API process.

## See also

- [Architecture](./architecture.md)
- [Privacy](./privacy.md)
- [Hosted team collaboration](./setting-up-collaboration.md)
- [Agent connections](./agent-plugins.md)
- [CLI reference](./cli.md)
