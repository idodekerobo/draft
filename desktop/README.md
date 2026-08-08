# Draft Desktop

The desktop app is an Electrobun application with a Bun main process and React
views.

## Local development / self-hosting

The recommended local entrypoint is:

```bash
make run-local
```

For desktop development, the launcher passes these root values to
`electrobun.config.ts`:

```env
DRAFT_API_BASE_URL=
DRAFT_APP_URL=http://localhost:3000
DRAFT_SUPABASE_URL=
DRAFT_SUPABASE_PUBLISHABLE_KEY=
```

During `electrobun dev`, those process environment values override the URL and
Supabase values read from `src/build-config.json`.

Standalone development remains available:

```bash
cd desktop
bun run dev
```

Without `make run-local`, standalone desktop development currently uses
`desktop/src/build-config.json`; there is no `desktop/.env.local`.

### Release builds

Release builds continue to use `src/build-config.json`. `electrobun.config.ts`
bakes the configured `DRAFT_*` values into the desktop bundle at build time.
`desktop/scripts/prebuild.sh` prepares the CLI and background assets and keeps
its existing PostHog build configuration behavior. Changing a local URL
requires restarting the desktop dev process or rebuilding the release.
