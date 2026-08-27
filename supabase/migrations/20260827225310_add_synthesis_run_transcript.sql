-- Full stream-json transcript (array of message objects) from the sandbox's
-- Claude Code run, captured for both successful and failed synthesis runs.
-- Lets workspace members see the model's reasoning behind a result, and
-- gives us a real trail to diagnose failures the collapsed final-result
-- envelope alone can't explain.
alter table synthesis_runs
  add column transcript_json jsonb;
