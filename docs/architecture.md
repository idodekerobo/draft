# Architecture

Draft is a hosted or self-hosted company-brain system. The workspace and synthesis pipeline live behind an authenticated API. Desktop, CLI, and agent integrations are local clients of that API.

## System shape

~~~text
                         Hosted Draft
                   or your self-hosted deployment
                              |
        +---------------------+---------------------+
        |                     |                     |
     Web app              Bun backend            Supabase
   signup/invites       auth/API/ingestion       auth/data/storage
        |                     |
        |          +----------+----------+
        |          |                     |
        |       Scheduler          Webhooks and APIs
        |          |                     |
        |          +----------+----------+
        |                     |
        |              Fly Machine sandbox
        |                     |
        +----------> workspace context <----------+
                              ^
                              |
       Desktop · CLI · MCP · agent hooks
                    running on user machines
~~~

## Local clients

### Desktop

The Electrobun desktop app is the main interactive workspace client. It signs users in through the web app, calls the backend with the current access token, displays cloud context and synthesis activity, manages integrations, and creates invite links.

The desktop can also read a local folder during onboarding to seed a workspace. That folder is source material for a synthesis run; it is not the long-term source of truth.

### CLI

The Bun CLI is a thin authenticated client for the Draft API. It supports auth, context and skill reads, coding-session capture setup, session listing/search/reading, and connecting/disconnecting the workspace's hosted integrations (GitHub, Slack, Linear, Fireflies, Granola, Claude Code). The desktop app and CLI both manage these connections. It defaults to the hosted API and can be configured for another deployment through DRAFT_API_BASE_URL, DRAFT_APP_URL, DRAFT_SUPABASE_URL, and DRAFT_SUPABASE_PUBLISHABLE_KEY.

### Agent connection

The remote MCP server is an OAuth-protected, stateless HTTP connection to the workspace. It resolves the caller's team workspace server-side and exposes read-only context and skills tools. The CLI and tool-specific setup commands remain useful for project-local instructions, explicit reads, scripts, and session capture. A session hook can read a completed coding-agent transcript and post it to the backend using an ingest token scoped to one project and provider set — a token minted for one project cannot submit sessions for another, even within the same workspace.

## Backend

The Bun backend starts the HTTP API, Slack listeners, and scheduler. Routes cover:

- Authentication and identity.
- Workspace context reads.
- Integration connection management.
- GitHub installation and callbacks.
- Source-item ingestion.
- Coding-agent session ingest, list, search, and read.
- Synthesis-run creation and status.
- Sandbox callbacks.

The backend uses Supabase for authenticated data access. Provider credentials are stored encrypted and are resolved per workspace when a synthesis run starts.

## Live updates

Apps learn that something changed from Supabase Realtime, not from polling. Database triggers send small signals on two private topics: `signals:session:<id>` (new events, inputs, session changes) and `signals:workspace:<id>` (the sessions list, context changes). A signal carries no content. The app fetches from the endpoint it already uses, so author names, per-viewer inputs and links stay computed by the server. Permissions are row security policies on `realtime.messages`, the same as the session and workspace rows.

The web app joins topics from the browser. On desktop, the main process holds the one connection and the token. The window sends the list of topics it wants and receives signals and the connection state through RPC. The session host in the main process listens on its session topic and runs its next pass when an input arrives.

Signals can be lost, so each client fetches again when a channel joins or rejoins, when the browser comes back online and when the tab becomes visible. Polls remain as slow safety nets: 60 seconds for an open session, 5 minutes for lists and workspace data, 10 seconds for the host's input request.

## Synthesis

The scheduler claims ready work and prepares a bounded run bundle from source evidence and the current context version. It starts a disposable Fly Machine using the Claude Code sandbox image. The runner receives a callback URL and token, executes the bounded task as an unprivileged user, and returns the result. The backend validates the result before committing a new workspace context version.

The long-running API does not run model work in-process. The sandbox is the isolation boundary for synthesis execution.

## Self-hosting stack

The supported reference stack is:

| Component | Responsibility |
|---|---|
| Supabase | Auth, Postgres, storage, and row-level access control |
| Bun backend | API, ingestion, scheduling, webhooks, and workspace access |
| Fly Machines | Disposable synthesis sandboxes |
| Next.js web app | Browser auth, invites, and pairing |
| Electrobun | Native desktop client |
| Bun CLI | Scriptable API and session client |

The repository does not currently provide a one-command production deployment. Operators configure each service and point all clients at the same deployment.

## GitHub

GitHub is a source integration. The backend can receive GitHub App events, the desktop can use GitHub source import during onboarding, and `draft integrations connect github` in the CLI drives the same App-installation flow — see [CLI reference](./cli.md#hosted-integrations). Collaboration uses hosted workspace context and the backend API.
