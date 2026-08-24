# Draft web app

This is the authenticated Next.js application for Draft. It provides browser-based signup and sign-in, desktop pairing, team invite acceptance, and a small authenticated workspace surface. It talks to the configured Draft Bun backend for workspace identity and API operations.

## Hosted Draft

The hosted app is available at [app.draftai.us](https://app.draftai.us). Users can create an account there or follow an invite link from a workspace administrator.

## Local development

From the repository root:

~~~bash
make run-local
~~~

Or run the app alone:

~~~bash
cd web-app
bun run dev
~~~

Required public configuration:

~~~env
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
NEXT_PUBLIC_API_BASE_URL=http://localhost:8787
~~~

Optional values:

~~~env
NEXT_PUBLIC_DOWNLOAD_URL=
PORT=3000
~~~

NEXT_PUBLIC_API_BASE_URL must be reachable by the browser. All NEXT_PUBLIC_* values are public and may be embedded in browser assets. Never put backend secrets in this app.

## Self-hosting

Deploy this app as the browser-facing frontend for your own Draft API and Supabase project. Set the public Supabase values and API URL to the same deployment used by the desktop and CLI. The backend's APP_URL must exactly match the deployed web origin for CORS.
