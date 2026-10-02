---
name: worktree-setup
description: Prepare a Draft git worktree for local development and CLI use.
---

# Worktree setup

When preparing a Draft worktree, identify the canonical checkout and the target
worktree with `git worktree list`. Then do all of the following from the target
worktree:

1. Copy the canonical checkout's root-level `.env.production` and `.env.staging`
   and ignored desktop configuration every time, even when the target worktree
   already has copies. Recreate the `.env.development` symlink so bare scripts
   load staging:

   ```bash
   cp "$SOURCE_ROOT/.env.production" "$TARGET_ROOT/.env.production"
   cp "$SOURCE_ROOT/.env.staging" "$TARGET_ROOT/.env.staging"
   ln -sf .env.staging "$TARGET_ROOT/.env.development"
   cp "$SOURCE_ROOT/apps/desktop/src/build-config.json" "$TARGET_ROOT/apps/desktop/src/build-config.json"
   ```

   The second copy is required even though `apps/desktop/src/build-config.json` is
   gitignored. It provides the Supabase values used when the local CLI binary
   is built. If either source file is missing, stop and report the missing file;
   do not invent or substitute credentials.

2. Install dependencies with the repository's package managers:

   ```bash
   bun install
   (cd apps/web && bun install)
   (cd apps/landing-page && npm install)
   ```

3. Link the worktree to the Supabase project so `supabase db push`/`diff`
   work from it (each worktree has its own gitignored link state under
   `supabase/.temp/`, so this does not carry over from the canonical
   checkout). Derive the project ref from the copied `.env.production`'s
   `SUPABASE_URL` (`https://<ref>.supabase.co`) rather than asking the user
   for it or guessing:

   ```bash
   ref=$(grep '^SUPABASE_URL=' "$TARGET_ROOT/.env.production" | sed -E 's#.*https://([a-z0-9]+)\.supabase\.co.*#\1#')
   supabase link --project-ref "$ref"
   ```

   Confirm with supabase db push --linked --dry-run — it should report
   either pending migrations or that the remote is up to date, not a
   project-ref error. Never run supabase db push --linked (without
   --dry-run) as part of this setup skill; applying migrations is a
   separate, explicit step the user asks for on its own.

4. Rebuild and install the worktree's local CLI, daemon, and runtime bundles:

   ```bash
   make dev-refresh
   ```

5. Verify that dependencies exist in `apps/web`, `apps/landing-page`, `backend`,
   and `apps/desktop`, and verify the installed CLI with `command -v draft` and
   `draft --version`.

Do not run `make run-local`; leave starting the local services to the user.
Never print configuration values, commit the copied ignored files, or discard
existing worktree changes.
