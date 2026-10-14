---
name: worktree-setup
description: Prepare a Draft git worktree for local development and CLI use.
---

# Worktree setup

When preparing a Draft worktree, identify the canonical checkout and the target
worktree with `git worktree list`. Set `SOURCE_ROOT` to the canonical checkout
and `TARGET_ROOT` to the requested worktree, then do the following from the
target worktree:

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
   is built. Copy these files even if destination copies already exist. If any
   source file is missing, stop and report its path; do not invent or substitute
   credentials. Never print their contents.

2. Install dependencies with the repository's package managers:

   ```bash
   bun install
   (cd apps/web && bun install)
   (cd apps/landing-page && bun install)
   ```

3. Check and link the worktree's Supabase CLI target. Each worktree has its own
   gitignored link state under `supabase/.temp/`. First check the current
   target, then use the repository helper, which reads the project ref and DB
   password from the selected env file:

   ```bash
   scripts/supabase-target.sh status
   scripts/supabase-target.sh prod
   scripts/supabase-target.sh status
   scripts/supabase-target.sh push --dry-run
   ```

   The dry-run must report pending migrations or that the remote is up to date.
   Never run a push without `--dry-run` as part of setup; applying migrations
   is a separate step requiring an explicit request. After checking production,
   leave the CLI linked to staging:

   ```bash
   scripts/supabase-target.sh status
   scripts/supabase-target.sh staging
   scripts/supabase-target.sh status
   ```

4. CLI and daemon rebuilding is optional. Do not run `make dev-refresh` during
   routine worktree setup. It installs this worktree's CLI and daemon into the
   shared `~/.draft` location, replacing the globally installed versions. Run
   it only when the user explicitly asks to refresh that shared install. If
   actively developing CLI/runtime code and only a worktree build is needed,
   run:

   ```bash
   bash apps/desktop/scripts/prebuild.sh
   ```

5. Verify that dependencies exist in `apps/web`, `apps/landing-page`, `backend`,
   and `apps/desktop`. `command -v draft` and `draft --version` report the
   globally installed CLI; they do not verify a worktree-specific install.

Do not run `make run-local`; leave starting the local services to the user.
Never print configuration values, commit the copied ignored files, or discard
existing worktree changes.
