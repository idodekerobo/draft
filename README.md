# Draft

Draft is the company brain for teams building with AI.

It turns the decisions, context, and activity scattered across your team's tools into a shared workspace that every connected agent can use. Agents attach to Draft through a local CLI or agent integration, so each session can start with the same current understanding of the company, product, priorities, and decisions.

Draft is available as a hosted service at [draftai.us](https://draftai.us), and the open-source stack can also be self-hosted.

![Draft Screenshot](assets/onboarding-screenshot.png)

## How Draft works

~~~text
Your tools and agent sessions
  Slack · GitHub · Fireflies · Linear · Claude Code
             |
             v
Local capture + agent connection
  Desktop · CLI · project hooks
             |
             v
Draft API and workspace
  Auth · integrations · context versions · session history
             |
             v
Server-side synthesis
  Scheduled ingestion and sandboxed Fly Machine runs
             |
             v
Company brain
  Shared context available to the web app, desktop, CLI, and agents
~~~

### What happens on the server

The Draft backend is the control plane for a team workspace. It handles authentication, organizations, invitations, integrations, webhooks, source data, coding-agent sessions, context versions, and synthesis runs.

Synthesis runs execute in disposable [Fly Machines](https://fly.io/docs/machines/) so model-backed processing is isolated from the long-running API. The backend schedules the work, prepares a bounded input bundle, starts the sandbox, validates the result, and commits the resulting context version to the workspace.

The hosted service runs this stack for you. In a self-hosted deployment, these services run in infrastructure you control.

### What happens locally

The local components connect your agents and computer to the Draft workspace:

- The Electrobun desktop app signs in, displays the shared workspace, manages connections, and shows synthesis activity.
- The CLI authenticates against the configured Draft API and can read workspace context and coding-agent session data.
- Agent integrations and project hooks let supported agents attach to Draft. The current CLI/plugin path is still evolving as we work toward the best long-term agent connection model.
- The `background/` module is a local daemon/runtime path still used by desktop bundles and current plugin hooks. It contains local pollers, session jobs, and source-adapter runtimes; it is not the hosted workspace or hosted synthesis control plane.
- A local hook can read a completed coding-agent transcript from the project machine and send it to the configured Draft API. The local machine keeps authentication state, project configuration, and temporary capture/runtime files.

The canonical company brain is the workspace in the Draft deployment, not a Git repository on the user's machine. Local files are connection state, caches, runtime state, or source material waiting to be uploaded.

## Use hosted Draft

1. Sign up at [draftai.us](https://draftai.us).
2. Download the Draft desktop app for macOS Apple Silicon.
3. Sign in and create or join a team workspace.
4. Connect the integrations your team uses.
5. Attach your coding agents using the current CLI/plugin setup.

The hosted web app handles account creation, sign-in, desktop pairing, and team invitations. The desktop app is the primary workspace surface today; the CLI is useful for agents, scripts, and session access.

## Self-host Draft

Self-hosting runs the same product architecture under your control:

- **Supabase** for authentication, Postgres data, storage, and row-level access control.
- **Bun backend** for the Draft API, ingestion, scheduling, webhooks, and workspace access.
- **Fly Machines** for disposable sandboxed synthesis runs.
- **Next.js web app** for authentication, invitations, and browser access.
- **Electrobun desktop app** configured to point at your API and web app.
- **Bun CLI** configured to point at your API and Supabase project.

The Makefile provides one-command local workflows, but not a single-command production deployment. `make run-local` starts the local web app, landing page, backend, and desktop supervisor. `make dev-refresh` rebuilds and installs the local CLI, daemon binary, and bundled background runtimes after changes to `cli/` or `background/`. A self-hosted production deployment still requires configuring and deploying each service, applying the Supabase migrations, creating the required GitHub App credentials, and providing the backend's Fly Machines configuration.

### Local development

The repository includes a local stack launcher for the web app, landing page, backend, and desktop app.

~~~bash
git clone https://github.com/idodekerobo/draft.git
cd draft
bun install
cp .env.example .env.local
# Fill in the private values in .env.local.
make run-local
# After changing cli/ or background/:
make dev-refresh
~~~

The local launcher starts:

| Service | Default address | Role |
|---|---|---|
| Web app | http://localhost:3000 | Auth, invites, pairing |
| Landing page | http://localhost:3001 | Marketing site |
| Backend | http://localhost:8787 locally | API, ingestion, scheduling |
| Desktop | Electrobun dev window | Workspace client |

The full local stack needs a publicly reachable HTTPS value for DRAFT_API_BASE_URL because the backend schedules callbacks and receives external webhooks. A tunnel such as ngrok is currently required for local development of those flows. make run-local validates the required URLs, ports, Supabase values, GitHub App values, and Fly sandbox values before starting.

See the app READMEs for standalone development and deployment configuration:

- [Backend](./backend/README.md)
- [Desktop](./desktop/README.md)
- [Web app](./web-app/README.md)
- [Landing page](./landing-page-app/README.md)
- [CLI and agent integration](./cli-agent-plugin/README.md)

## Repository structure

~~~text
draft/
├── backend/              # Bun API, ingestion, scheduler, and synthesis orchestration
├── web-app/              # Next.js auth, invite, and browser application
├── desktop/              # Electrobun desktop workspace client
├── cli/                  # Bun CLI for hosted or self-hosted API access
├── core/                 # Shared auth, config, runtime, and sync primitives
├── background/           # Local daemon/runtime, pollers, and source adapters
├── cli-agent-plugin/     # Current, evolving agent connection integrations
├── landing-page-app/     # Next.js marketing site
├── supabase/             # Database migrations and local Supabase configuration
└── Makefile              # Local stack and release automation
~~~

## Current integrations

The backend currently supports connections for Slack, Fireflies, Linear, GitHub, and Claude Code session capture. GitHub is an integration and source of activity, and can also be used for source import. It is no longer the primary team-context synchronization layer.

## CLI

Install a released CLI binary without cloning the repository:

~~~bash
curl -fsSL https://raw.githubusercontent.com/idodekerobo/draft/main/scripts/install-cli.sh | bash
~~~

The installer supports macOS arm64/x64 and Linux x64. The CLI uses the hosted Draft API by default. For another deployment, set DRAFT_API_BASE_URL, DRAFT_APP_URL, DRAFT_SUPABASE_URL, and DRAFT_SUPABASE_PUBLISHABLE_KEY as appropriate for that deployment.

Common commands:

~~~bash
draft auth login
draft auth whoami
draft context list
draft context read --all
draft sessions list
draft --help
~~~

See [docs/cli.md](./docs/cli.md) for the current CLI surface.

## Documentation

- [What is Draft](./docs/overview.md)
- [Architecture](./docs/architecture.md)
- [Privacy](./docs/privacy.md)
- [Hosted team collaboration](./docs/setting-up-collaboration.md)
- [Agent connections](./docs/agent-plugins.md)
- [How context reaches agents](./docs/how-context-injection-works.md)
- [CLI reference](./docs/cli.md)
- [Synthesis and proposals](./docs/proposals.md)

## Platform support

- Hosted web app: any supported modern browser.
- Desktop app: macOS on Apple Silicon today.
- CLI releases: macOS arm64/x64 and Linux x64.
- Agent integration: current hooks require a POSIX shell; the connection surface is evolving.
