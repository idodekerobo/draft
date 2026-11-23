# Routine sandbox rollout — 2026-11-23

The sandbox images for configurable synthesis and session-summary routines were built, verified and activated in staging and production. The backend and UI feature changes remain a separate release.

## Image references

Both apps use the same image manifest digest:

```text
sha256:034585f37bbc4b5bf157c58377884e6355bd9893963fc2cf5bfca6f30a1c4fe5
```

| Environment | Active image reference | Configuration updated |
| --- | --- | --- |
| Staging | `registry.fly.io/draft-sandbox-staging@sha256:034585f37bbc4b5bf157c58377884e6355bd9893963fc2cf5bfca6f30a1c4fe5` | Root `.env.staging` |
| Production | `registry.fly.io/draft-sandbox-prod@sha256:034585f37bbc4b5bf157c58377884e6355bd9893963fc2cf5bfca6f30a1c4fe5` | Root `.env.production` and Railway service `draft`, environment `production`, variable `FLY_SANDBOX_IMAGE` |

The previous digest in both registries was:

```text
sha256:b31bc0e35b154ddcd4b7d4485510f189bda806c0920dd55c8254c754484d2d94
```

Railway deployment `a10f25a6-283f-45f4-826a-77fafacb36b3` reached `SUCCESS`; the production `/health` check returned HTTP 200. Environment files are gitignored and are not included in commits.

## Verification

- Both registry manifests and their runner layers were checked. The runner contains the Codex schema flag, structured-result parser and refreshed-login callback support.
- The pinned `codex-cli 0.166.0` ran on disposable Fly machines in both apps. Synthetic checks covered the actual synthesis schema, the actual summarization schema and a two-session batch.
- A local mock Responses provider verified the JSON schema forwarded by the CLI and supplied synthetic results. Each check verified the parsed payload and a delivered callback. These checks did not use a live model or company source data.
- The backend verification suite passed 634 tests, with three external Fly provider conformance tests skipped. Targeted core, composer and CLI checks also passed.

## Backfill status

`supabase/migrations/20261123182812_backfill_builtin_routine_agent_settings.sql` is the one-time data migration for existing routine rows. It fills missing prompt, harness and model settings while preserving customizations, schedules, paused states and ownership. Disposable Postgres checks also verified repeated execution and exclusion of unrelated and deleted tasks.

The migration was applied to staging and verified against all nine active built-in routine rows. Production had eight rows needing backfill: six synthesis tasks and two summarization tasks. The production dry run contained only this migration; production application still requires separate approval.

Staging has a pre-existing applied migration, `20261120060549_notifications`, absent from this checkout and production. Its recorded SQL was temporarily recovered for the staging push, then removed from the local migration directory so it would not enter the production plan. This history mismatch needs reconciliation before future staging pushes. No migration history was repaired or rewritten. The CLI was left linked to staging.
