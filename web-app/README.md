# Draft Web App

This is the authenticated Next.js web application.

## Local development / self-hosting

The recommended repository-wide entrypoint is:

```bash
make run-local
```

It starts this app at `http://localhost:3000` and maps the root `.env.local`
values to the `NEXT_PUBLIC_*` names expected by Next.js.

For standalone development:

```bash
cd web-app
bun run dev
```

Standalone development currently uses `web-app/.env.local`. The existing file
and `web-app/.env.local.example` are intentionally preserved during the root
env migration.

### Required

```env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
```

`NEXT_PUBLIC_API_BASE_URL` must match the backend URL the browser can reach. If
the backend is exposed through ngrok, use that same ngrok URL here and in the
root `DRAFT_API_BASE_URL` value.

### Optional

```env
NEXT_PUBLIC_DOWNLOAD_URL=
PORT=3000
```

All `NEXT_PUBLIC_*` values are public and may be embedded into browser assets;
never place backend secrets in this app's environment.
