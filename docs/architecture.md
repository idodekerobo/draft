# Architecture

Draft is a hosted or self-hosted company-brain system. The workspace and synthesis pipeline live behind an authenticated API. Desktop, CLI, and agent connections are local clients of that API.

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

The Electrobun desktop app is the main interactive workspace client. It signs users in through the web app, calls the backend with the current access token, displays cloud context and synthesis activity, manages connections, and creates invite links.

The desktop can also read a local folder during onboarding to seed a workspace. That folder is source material for a synthesis run; it is not the long-term source of truth.

### CLI

The Bun CLI is a thin authenticated client for the Draft API. It supports auth, context and skill reads, coding-session capture setup, session listing/search/reading, and connecting/disconnecting the workspace's hosted connections (GitHub, Slack, Linear, Fireflies, Granola, Claude Code). The desktop app and CLI both manage these connections. It defaults to the hosted API and can be configured for another deployment through DRAFT_API_BASE_URL, DRAFT_APP_URL, DRAFT_SUPABASE_URL, and DRAFT_SUPABASE_PUBLISHABLE_KEY.

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

A synthesis run is a routine made of three steps. The run itself starts no agent. It starts step runs, and each step run gets its own sandbox and its own bundle.

1. **Capture** reads new sources in batches and returns memory entries, each naming the stable documents it bears on. It writes nothing. A batch that fails twice leaves its sources pending for the next run.
2. **Reconcile** runs once for each stable document with new evidence. It checks the document against the evidence, rewrites what is out of date, and returns the claims the evidence cannot settle.
3. **Organize** writes the entries into memory, records the open conflicts, and returns the run's outcome and its questions for people.

Step runs are `agent_runs` rows with `kind = 'step'` and a `parent_run_id`. The backend advances the run each time a step run reports back, and the scheduler tick and a sweep advance runs that stall. A step run that fails retries once. A rate-limited one retries up to three times with a wait. Claude runs up to four step runs at a time. Codex runs one at a time because a Codex login allows one run. If a step fails after its retries, the run fails, and documents already updated stay updated. Each step run saves its token usage in `usage_json`.

The long-running API does not run model work in-process. The sandbox is the isolation boundary for synthesis execution.

### Where the code lives

"Update company context" is a built-in routine, so its code sits under `backend/src/routines/`:

- `routines/workflow/` is the step engine. It plans, starts, retries and advances step runs for any routine that has steps. It imports nothing from the rest of `routines/`.
- `routines/built-in/synthesis/` is synthesis: its steps, prompts, source batching, finishing and retries. It uses the engine.
- `routines/built-in/summarization/` is session summarization: it claims captured coding sessions, runs one agent over a batch, and stores the summaries. It starts when a team connects Claude coding sessions as a source.
- The other files in `routines/` are custom routines and the shared routine settings. They use the engine too.
- `routines/register-workflows.ts` is the one place that tells the engine how each kind of routine carries out its steps.

Context helpers that synthesis and other code share live in `metaharness/context/`.

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

GitHub is a source integration. The backend can receive GitHub App events, the desktop can use GitHub source import during onboarding, and `draft connections connect github` in the CLI drives the same App-installation flow — see [CLI reference](./cli.md#hosted-connections). Collaboration uses hosted workspace context and the backend API.
