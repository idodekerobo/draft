# Draft Backend

The backend is a Bun HTTP server. From the repository root, the recommended
local entrypoint is `make run-local`; it passes the root `.env.local` values to
the backend using the names shown below.

## Local development / self-hosting

For standalone development:

```bash
cd backend
bun run dev
```

Standalone startup currently reads `backend/.env.local`. The root launcher also
preserves that file as a migration fallback; do not delete it yet.

### Required at backend startup

```env
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
```

### Required for the full local stack / enabled features

```env
PORT=8787
APP_URL=http://localhost:3000
DRAFT_API_BASE_URL=http://localhost:8787

FLY_API_TOKEN="FlyV1 ..."
FLY_APP_NAME=
FLY_SANDBOX_IMAGE=
FLY_REGION=
SANDBOX_CALLBACK_SECRET=
INFERENCE_CREDENTIAL_KEK_V1=
```

`APP_URL` is the exact browser origin permitted by CORS. `DRAFT_API_BASE_URL`
is the single public/reachable backend URL used for webhook/callback URLs
(sandbox config), the Slack listener's own base URL, and as the fallback
`apiBaseUrl` in `config.ts`; it may be an ngrok URL while `PORT` remains
`8787` locally. (`API_BASE_URL` was consolidated into this single var —
do not set both.)

The Slack listener additionally uses:

```env
SLACK_BATCH_MAX_CONTENT_BYTES=
SLACK_BATCH_MAX_MESSAGES=
SLACK_BATCH_MAX_SPAN_HOURS=
```

`SUPABASE_DB_PASSWORD` and `SPIKE2_CALLBACK_PORT` are only needed for the
corresponding local tooling/features; the Slack limit variables are optional
overrides.

`CLAUDE_CODE_OAUTH_TOKEN` is **not** read by the deployed server. Each
synthesis run resolves a per-workspace token from the encrypted `credentials`
table (`synthesis/resolve-credential.ts`) and injects it directly into the
disposable Fly sandbox Machine — the backend process's own env is never
consulted. Only the local spike scripts under `backend/scripts/` (e.g.
`spike3-round-trip.ts`) read this var from `process.env` directly; set it in
your shell only when running those.

For deployment, provide backend variables through the deployment environment;
do not copy the complete root local env into a public web service.
