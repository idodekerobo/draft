---
name: staging-env
description: Switch between the staging and prod Supabase environments — run the local app, run seed/demo scripts, and push migrations against staging first. Use for any task that seeds fake data, tests a migration, or runs the stack against a non-prod database.
---

# Skill: staging-env

Two Supabase projects exist. Staging is the default for bare commands; prod is
opt-in and always explicit.

| | Env file | Supabase CLI target |
|---|---|---|
| prod | `.env.production` (gitignored) | `scripts/supabase-target.sh prod` |
| staging | `.env.staging` (gitignored) | `scripts/supabase-target.sh staging` |

`.env.development` is a symlink to `.env.staging`. Bun loads it when `NODE_ENV`
is unset, so a bare `bun run ...` or `bun -e ...` from the repo root gets staging
values. Create it once per checkout: `ln -s .env.staging .env.development`.
Prod loads only through `--env-file=.env.production` or `NODE_ENV=production`.
Bun reads env files from the current directory, so a bare run from a
subdirectory loads nothing.

## 1. Always check the target first

```
scripts/supabase-target.sh status   # prints staging / PROD and the ref
```

The CLI link (`supabase/.temp/project-ref`) is global state. It decides where
`db push --linked` goes. Never assume it.

## 2. Run the app against staging

```
make run-local                 # staging is the default
make run-local env=production  # prod, only when the user asks
```

Ports 3000/3001/8787 are shared. Do not run both at once.
`apps/desktop/src/build-config.json` is for packaged prod builds only. Ignore it here.

## 3. Run seed / demo scripts against staging

A bare run loads staging, but pass the env file anyway so the target is explicit:

```
bun --env-file=.env.staging run backend/scripts/seed-demo-nonprofit.ts
```

`--env-file` overrides the auto-loaded `.env.development` (verified). Before running a
script that writes data, confirm the target:

```
bun --env-file=.env.staging -e 'console.log(process.env.SUPABASE_URL)'
```

Scripts that write or delete data (`seed-*`, `demo-seed-*`, `delete-demo`,
`wipe-user`, `clear-stuck-run`, `create-invite`, ...) are staging-only unless the
user explicitly names prod.

## 4. Push a migration: staging first, then prod

1. `supabase migration new <name>`, write the SQL.
2. `scripts/supabase-target.sh staging`
3. `supabase db push --linked --dry-run`, then `supabase db push --linked`
   (staging needs `--password` from `.env.staging` if prompted).
4. Verify on staging: run the app or a seed script that exercises the change.
5. Update `db/schemas/`, `db/functions/`, `db/storage/` by hand.
6. Get explicit user approval, then `scripts/supabase-target.sh prod`,
   dry-run, push.
7. Leave the CLI linked to **prod** when done (`scripts/supabase-target.sh prod`).
   Always run `status` at the end of the session.

## 5. What `db push` does NOT carry to a new environment

Set by hand in the Supabase dashboard of any new project:
- Auth Site URL and Redirect URLs.
- Email provider: confirmations off (matches `supabase/config.toml`).
Set in that env's `.env.*` file, and use a distinct value from prod:
- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`, `SUPABASE_DB_PASSWORD`
- `BETTER_AUTH_DATABASE_URL` (direct Postgres string), `BETTER_AUTH_SECRET`
- `INFERENCE_CREDENTIAL_KEK_V1`

## 6. Known gap: shared third-party resources

`.env.staging` was cloned from the prod env file. These may still point at prod:
GitHub App, Fly app/image/token, Slack, `DRAFT_API_BASE_URL` tunnel.
Seeding fake data is safe. Triggering real synthesis runs, webhooks or Fly
sandboxes from staging uses prod's accounts. Point them at test resources first.
