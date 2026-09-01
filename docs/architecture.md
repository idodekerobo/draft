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
          Desktop · CLI · agent hooks · local daemon
                    running on user machines
~~~

## Local clients

### Desktop

The Electrobun desktop app is the main interactive workspace client. It signs users in through the web app, calls the backend with the current access token, displays cloud context and synthesis activity, manages integrations, and creates invite links.

The desktop can also read a local folder during onboarding to seed a workspace. That folder is source material for a synthesis run; it is not the long-term source of truth.

### CLI

The Bun CLI is a thin authenticated client for the Draft API. It supports auth, context reads, coding-session capture setup, session listing/search/reading, and connecting/disconnecting the workspace's hosted integrations (GitHub, Slack, Linear, Fireflies, Claude Code). The desktop app and CLI both manage these connections. It defaults to the hosted API and can be configured for another deployment through DRAFT_API_BASE_URL, DRAFT_APP_URL, DRAFT_SUPABASE_URL, and DRAFT_SUPABASE_PUBLISHABLE_KEY.

### Agent connection

The CLI and tool-specific setup commands install project-local hooks. A session hook can read a completed coding-agent transcript and post it to the backend using an ingest token scoped to one project and provider set — a token minted for one project cannot submit sessions for another, even within the same workspace. Agent connections use the API contract and support multiple local setup methods.

### Background daemon

The `background/` module powers the local desktop runtime. It provides the installed daemon, local pollers, session jobs, and bundled source/intelligence adapters. `desktop/scripts/prebuild.sh` copies and bundles it into desktop assets, and `make dev-refresh` installs the local runtime. Agent connections are opt-in through the CLI or tool-specific setup. Hosted production ingestion and synthesis run through the Bun backend and Fly Machine sandbox; the background module handles local capture and source processing.

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
