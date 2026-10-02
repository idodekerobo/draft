-- Fly machine id of the sandbox that ran the synthesis. Lets us match a run
-- row to Fly logs when diagnosing a failure.
alter table synthesis_runs
  add column sandbox_machine_id text;
