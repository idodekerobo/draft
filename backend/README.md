# Draft backend

The backend is Draft's Bun control plane. It serves authenticated workspace APIs, receives integration webhooks and source data, schedules synthesis, stores context versions and coding-agent sessions, and coordinates disposable Fly Machine sandboxes.

The hosted Draft service runs this backend for users. Self-hosting means deploying this service with your own Supabase project and Fly Machines account.

## Responsibilities

- Authenticate users and enforce organization, team, and workspace access.
- Store workspace context versions, source items, synthesis runs, and agent sessions in Supabase.
- Receive Slack, Fireflies, Linear, and GitHub events and manage connected-source state.
- Accept coding-agent session uploads from local project hooks.
- Schedule ingestion and synthesis work.
- Start one-shot Claude Code sandbox Machines on Fly, pass them bounded run bundles, and validate their callbacks.

The API is the source of truth for hosted workspace context. Local desktop and CLI processes read it through authenticated requests.

## Run locally

From the repository root:

~~~bash
bun install
cp .env.example .env.local
# Fill in the private values.
make run-local
~~~

Or run only the backend:

~~~bash
cd backend
bun run dev
~~~

The server listens on PORT (default 8787). For webhook and sandbox callback flows, DRAFT_API_BASE_URL must be a public HTTPS URL even when the process itself listens on localhost.

## Required backend configuration

~~~env
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_PRIVATE_KEY=
GITHUB_APP_WEBHOOK_SECRET=
~~~

## Sandbox and deployment configuration

~~~env
PORT=8787
APP_URL=https://app.example.com
DRAFT_API_BASE_URL=https://api.example.com
FLY_API_TOKEN=FlyV1 ...
FLY_APP_NAME=
FLY_SANDBOX_IMAGE=
FLY_REGION=
SANDBOX_CALLBACK_SECRET=
INFERENCE_CREDENTIAL_KEK_V1=
~~~

APP_URL is the browser origin allowed by CORS. DRAFT_API_BASE_URL is the externally reachable API URL used for callbacks, webhooks, and client configuration. FLY_SANDBOX_IMAGE identifies the Claude Code sandbox image built from src/sandbox/claude-code/.

The backend resolves each workspace's inference credential from the encrypted credentials table and injects it into the disposable sandbox. CLAUDE_CODE_OAUTH_TOKEN is not the deployed server's credential mechanism; it is used only by local spike scripts.

Optional Slack batching overrides are SLACK_BATCH_MAX_CONTENT_BYTES, SLACK_BATCH_MAX_MESSAGES, and SLACK_BATCH_MAX_SPAN_HOURS. See the root .env.example for the complete local configuration surface.

## Tests

~~~bash
cd backend
bun test
~~~

Database migrations live in supabase/migrations/. Current-state schema snapshots live under db/.
