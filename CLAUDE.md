
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
