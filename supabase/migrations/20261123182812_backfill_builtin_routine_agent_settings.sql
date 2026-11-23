-- Initialize the two team routines without replacing any saved customization.
-- Schedules, enabled states, ownership and execution history are preserved.
with defaults(task_type, prompt) as (
  values
    ('synthesize_workspace', $routine_prompt$Read each source file, then read the existing context files above before deciding what changes.

**SIGNAL -- capture:**
- Product or architecture decisions made
- Action items with clear owners
- Direction changes, new constraints, or validated/invalidated assumptions
- Team-relevant facts about users, customers, competitors, or the market

**NOISE -- skip:**
- Small talk, scheduling, logistics
- Anything already captured in the existing context files
- Speculative ideas with no decision or action
- Implementation minutiae

**Specificity rule:** "Decided to drop X in favor of Y after confirming Z" is SIGNAL.
"Discussed some options" is NOISE.

## Judgment
- Preserve all still-valid context. Rewrite a file only when the evidence makes its durable current state clearer.
- A later timestamp is not a resolution receipt. Do not treat recency alone as proof one side of a conflict supersedes another.
- Use needs_input only for a named conflict whose competing claims cannot be safely reconciled from the evidence. Name both claims and their sources.
- Do not invent information not present in the source material.
- Do not copy raw source text verbatim into context; write synthesized insights.
$routine_prompt$),
    ('summarize_sessions', $routine_prompt$## Judgment
- Identify who was working (from the transcript content, not metadata) and on what project.
- Describe the outcome plainly: what shipped, what was left unresolved, what broke.
- List only decisions with real consequence -- architecture choices, scope cuts, direction changes. Skip routine implementation steps.
- Do not invent information not present in the transcript.
$routine_prompt$)
)
update public.scheduled_tasks as task
set config_json =
  (task.config_json - 'prompt' - 'harness' - 'model') ||
  jsonb_build_object(
    'prompt', coalesce(task.config_json->>'prompt', defaults.prompt),
    'harness', coalesce(task.config_json->>'harness', 'claude'),
    'model', coalesce(task.config_json->'model', 'null'::jsonb)
  )
from defaults
where task.task_type = defaults.task_type
  and task.deleted_at is null
  and (
    task.config_json->>'prompt' is null
    or task.config_json->>'harness' is null
    or not (task.config_json ? 'model')
  );
