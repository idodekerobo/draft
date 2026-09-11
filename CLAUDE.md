
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
- Fly sandbox image/Dockerfile/entrypoint/runner changes, new Fly sandbox environment → invoke fly-sandbox-image

## Writing Code
- Comments on SQL files that explain the data model or functions are fine
- For source code, only leave comments for code that is unituitive from the code itself. When you do, you should keep them clean/concise trying not to exceed 3 lines.
- `// TODO:` comments are acceptable for future work or items that need to be picked up later.

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
3. `supabase db push --linked --dry-run` to preview, then
   `supabase db push --linked` to apply to the linked remote project.
4. Update the corresponding file(s) in `db/schemas/`, `db/functions/`,
   and/or `db/storage/` by hand to match the new state. This does not
   happen automatically — never skip it.

Never write raw SQL directly against the remote database outside this flow,
and never leave `db/schemas/`, `db/functions/`, or `db/storage/` out of
sync with what's actually applied.

Do not push to the linked Supabase project until you get explicit approval that I'm good with the changes.

<!-- draft:begin (managed by Draft — do not edit this block) -->
## Draft context

This project uses Draft for its company brain and agent context.

Use the CLI below to access the company brain — Draft's current, synthesized
context about the product, team, and priorities — whenever you need it.

- `draft auth login` — sign in if a command reports you're not authenticated.
- `draft context list` — discover available context dimensions.
- `draft context read --dimension <name>` (repeatable) or `--all` — read current context.
- `draft --help` — see all available commands.

### Coding sessions

- `draft sessions list [--provider <p>] [--user <email>] [--since <ISO>]` — list captured sessions.
- `draft sessions read <id> [--summary|--transcript]` — read one session's summary or raw transcript.
- `draft sessions search "<pattern>"` — search session **summaries** by keyword (fast, snippet-only).
- `draft sessions read <id> --transcript --grep "<pattern>" [--context <n>]` and `--max-bytes <n>` — search a raw transcript (different corpus than `search` — see `draft sessions search` vs. `draft sessions read --grep` in `docs/cli.md`).

List sessions and read summaries first. Fetch a full transcript, or use
`--grep`, only when the summary is missing, stale, or insufficient.

Resolve people by exact display name or Git email. Present choices when a
name is ambiguous.

### Hosted integrations

- `draft integrations list` — see which of GitHub, Linear, Slack, Fireflies,
  and Claude Code are connected.
- `draft integrations connect <github|linear|slack|fireflies|claude-code>` —
  connect one. These need a human at a terminal (browser handoffs, hidden
  credential prompts) — don't run this on the user's behalf unless asked.
- `draft integrations disconnect <github|linear|slack|fireflies>` —
  disconnect one.

### Skills

Draft's skills are a company skill marketplace — reusable procedures,
templates, and heuristics the team has saved for any future workflow, not
just one task type.

- Discover: before starting a task that might match an existing company
  procedure, run `draft skills list` to browse the marketplace. Read the
  full description text for each; if one matches, run `draft skills read
  <name>` and follow it.
- Add: when a teammate asks you to save a template or procedure for future
  use, run `draft skills add` with the content. Write the description the
  way you'd write a skill's own SKILL.md description — the same judgment
  you already use for that format's frontmatter.
- `draft skills --help` — see add/update/remove/list/read usage.
<!-- draft:end -->
