# Draft desktop

The desktop app is Draft's native workspace client. It is built with Electrobun, with a Bun main process and React views.

The app signs in to a Draft deployment, reads the current workspace context, displays synthesis activity, manages source connections, and handles team invites. The canonical workspace is server-side; the desktop app is a client of that workspace.

## Hosted Draft

Download the macOS Apple Silicon build from [draftai.us](https://draftai.us), launch it, and sign in through the browser. The hosted desktop build points at the production Draft web app, API, and Supabase project.

## Local development

The repository-wide launcher is:

~~~bash
make run-local
~~~

For standalone desktop development:

~~~bash
cd apps/desktop
bun run dev
~~~

Development values are supplied by make run-local or by apps/desktop/src/build-config.json when running the desktop directly. Supported development overrides are:

~~~env
DRAFT_API_BASE_URL=http://localhost:8787
DRAFT_APP_URL=http://localhost:3000
DRAFT_SUPABASE_URL=
DRAFT_SUPABASE_PUBLISHABLE_KEY=
~~~

For local source imports, the desktop may also read files from the project machine. Those files are source material, not the authoritative shared workspace. Manage Claude Code session capture with `draft sessions` in the CLI.

## Release builds

Release builds use apps/desktop/src/build-config.json. electrobun.config.ts bakes the configured API, app, and Supabase public values into the bundle. A release build must point at the intended hosted or self-hosted deployment before packaging.

~~~bash
cd apps/desktop
bun run build:dev
~~~

Production releases use make desktop-release v=<version> from the repository root and require Apple Developer signing and notarization credentials.
