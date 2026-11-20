
## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Fly sandbox image/Dockerfile/entrypoint/runner changes (including `core/src/harnesses/*/runner.ts` and the run manifest), new Fly sandbox environment → invoke fly-sandbox-image
- Seeding/demo data, testing a migration, running against staging, switching Supabase env → invoke staging-env

## Writing Code
- Comments on SQL files that explain the data model or functions are fine
- For source code, only leave comments for code that is unituitive from the code itself. When you do, you should keep them clean/concise trying not to exceed 3 lines.
- `// TODO:` comments are acceptable for future work or items that need to be picked up later.
- Do not reference plan files, task numbers or ID's in the comments of code. Plan files are ephemeral and not tracked long term.

## Naming
`GLOSSARY.md` defines every domain word. Use those words in code, SQL, docs and UI. If a name disagrees with the
glossary, fix the name or propose a glossary update in the same change. Ask me for explicit approval before making any changes to `GLOSSARY.md`. If a new concept needs a glossary entry, propose it and get my approval before adding it.

## Database changes (backend/Supabase)

`supabase/migrations/` is the applied source of truth (the Supabase CLI
hardcodes this path — it cannot be relocated). `db/schemas/<table>.sql`,
`db/functions/<function>.sql`, and `db/storage/<bucket>.sql` are
hand-maintained current-state snapshots (one per table, one per function,
one per storage bucket) kept for humans/agents to read schema without
querying the live database.

Whenever a schema change is made — including a storage bucket's config or
policies, not just tables/functions — both must happen together, every
time:

1. `supabase migration new <short_name>` — creates the timestamped file in
   `supabase/migrations/`. Do not hand-write the timestamp.
2. Write the SQL in that generated file.
3. Apply to **staging first** (see "Staging first" below), verify, then
   `scripts/supabase-target.sh push --dry-run` and
   `scripts/supabase-target.sh push` against prod.
4. Update the corresponding file(s) in `db/schemas/`, `db/functions/`,
   and/or `db/storage/` by hand to match the new state. This does not
   happen automatically — never skip it.

Never write raw SQL directly against the remote database outside this flow,
and never leave `db/schemas/`, `db/functions/`, or `db/storage/` out of
sync with what's actually applied.

Do not push to the prod Supabase project until you get explicit approval that I'm good with the changes.

## Staging first

A separate staging Supabase project exists. Bare `bun` scripts and
`make run-local` load staging (`.env.staging`). Prod values live in
`.env.production` and are used only by explicit commands, but the linked CLI can
still point at prod, so check the target first. Invoke the `staging-env` skill
for the exact commands.

- Run `scripts/supabase-target.sh status` before any `supabase` command that
  touches a remote DB. The CLI link is global state.
- Use `scripts/supabase-target.sh` (`staging`, `prod`, `push [--dry-run]`) for
  remote Supabase CLI work. It passes the DB password from the env file. Raw
  `supabase db push` and `supabase migration list` fail with a password error.
- Test and verify every migration on staging before it goes to prod.
- Run seed, demo, wipe and other data-writing scripts (`backend/scripts/*`)
  against staging only, via `bun --env-file=.env.staging run ...`. Pass the env
  file even though a bare run loads staging, and never use `.env.production`
  unless I name prod explicitly.
- Run the app for manual testing with `make run-local` (staging by default).
  Prod is `make run-local env=production`, only when I ask.
- Leave the CLI linked to staging when a session ends
  (`scripts/supabase-target.sh staging`). Switch to prod only for an approved
  prod step, then switch back.

## Fly sandbox image

A backend deploy does not rebuild the Fly sandbox image. Each environment keeps
running the image its config points to, so old runner code can outlive a deploy.
The runner is bundled into the image (`bun run build:runner` in `backend`), so
any file in that bundle is part of the image. Invoke the `fly-sandbox-image`
skill when you change any of these, or what the backend sends to or expects
from the runner:

- `backend/src/sandbox/runner.ts` and `backend/src/sandbox/runner/*`
- `backend/src/sandbox/host.ts`, `backend/src/sandbox/host/*` and `core/src/host/*` (the cloud-session host bundle)
- `backend/src/sandbox/image/*` (Dockerfile, entrypoint, egress script)
- `core/src/harnesses/*/runner.ts`, `core/src/harnesses/failure.ts`
- `core/src/run-manifest.ts` and `core/src/run-spec.ts`
- the manifest or environment in `backend/src/metaharness/sandbox/launch.ts` and `run-manifest.ts`

The change is not done until the skill's steps are complete. Switching an
environment to a new image needs my explicit approval.

<!-- draft:begin (managed by Draft — do not edit this block) -->
## Draft context

This project uses Draft for its company brain and agent context.

Use the CLI below to access the company brain — Draft's current, synthesized
context about the product, team, and priorities — whenever you need it.

### Getting the latest information

For anything about what is happening now, read memory first. It holds daily,
weekly, and monthly summaries of what happened in the business.

- `draft context read --dimension memory --period <id>` — read one memory document.
  `<id>` is a day (`YYYY-MM-DD`), a week (`week-YYYY-MM-DD`, using that week's
  Monday), or a month (`YYYY-MM`). Aliases like `today`, `this-week` and
  `last-month` also work. For a longer span, read several periods and combine them.

Use `draft context list` and `draft context read --dimension <name>` for stable
background (product, team, priorities).

### Commands

- `draft auth login` — sign in if a command reports you're not authenticated.
- `draft context list` — discover available context dimensions.
- `draft context read --dimension <name>` (repeatable) or `--all` — read current context.
- `draft --help` — see all available commands.

### Source evidence

Context is Draft's maintained business map. Sources are direct evidence across providers.
Use context for orientation, then search and read sources when the map is incomplete
or when a claim needs direct support.

- `draft sources list [--provider <p>] [--type <t[,t...]>]` — browse ingested evidence without a query.
- `draft sources search "<query>" [--provider <p>] [--type <t[,t...]>] [--since <UTC>] [--until <UTC>]` — search stored default representations.
- `draft sources read <source_item_id> [--representation default|transcript|messages|structured]` — read selected evidence with bounded continuation.
- `draft sources capture enable claude-code --dir <repo>` — install a repository-local Claude Code capture hook.

A readable original transcript may not be searchable: default representations vary by
provider and can be summaries, rendered source content, or mixed content. Draft returns
evidence; the calling agent owns investigation, comparison, and answer generation.

### Sessions

- `draft sessions list [--provider <harness>] [--since <ISO>]` — list interactive conversations created in the Draft app.
- `draft sessions read <id>` — read a Draft app conversation and its events.
Captured coding sessions are source items with type `coding_session`; use `draft sources list` to browse them.

### Hosted connections

- `draft connections list` — see which of GitHub, Linear, Slack, Fireflies,
  Granola, and Claude Code are connected.
- `draft connections connect <github|linear|slack|fireflies|granola|claude-code>` —
  connect one. These need a human at a terminal (browser handoffs, hidden
  credential prompts) — don't run this on the user's behalf unless asked.
  Granola also takes `--workspace-key` to connect the workspace's shared key
  instead of a personal one, and requires a Granola Business/Enterprise plan.
- `draft connections disconnect <github|linear|slack|fireflies|granola>` —
  disconnect one (Granola also takes `--workspace-key`).

### Skills

Skills are reusable procedures the team saved. Use them only when the user
names a skill or asks for a saved workflow or template.

- `draft skills list` / `draft skills read <name>` — find and read a skill.
- `draft skills add` — save a procedure when a teammate asks. Write the description
  the way you'd write a skill's own SKILL.md description.
- `draft skills --help` — see add/update/remove/list/read usage.
<!-- draft:end -->
