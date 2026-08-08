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
API_BASE_URL=http://localhost:8787

FLY_API_TOKEN="FlyV1 ..."
FLY_APP_NAME=
FLY_SANDBOX_IMAGE=
FLY_REGION=
SANDBOX_CALLBACK_SECRET=
INFERENCE_CREDENTIAL_KEK_V1=
CLAUDE_CODE_OAUTH_TOKEN=
```

`APP_URL` is the exact browser origin permitted by CORS. `API_BASE_URL` is the
public/reachable backend URL used when constructing webhook and callback URLs;
it may be an ngrok URL while `PORT` remains `8787` locally.

The Slack listener additionally uses:

```env
DRAFT_API_BASE_URL=
SLACK_BATCH_MAX_CONTENT_BYTES=
SLACK_BATCH_MAX_MESSAGES=
SLACK_BATCH_MAX_SPAN_HOURS=
```

`SUPABASE_DB_PASSWORD`, `SPIKE2_CALLBACK_PORT`, and the Slack limit variables
are only needed for the corresponding local tooling/features.

For deployment, provide backend variables through the deployment environment;
do not copy the complete root local env into a public web service.
