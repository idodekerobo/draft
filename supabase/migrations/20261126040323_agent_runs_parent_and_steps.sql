-- Step runs: a routine with steps (such as synthesis) starts one run per step, or per item of a step.
-- A step run points at the run of its routine through parent_run_id. step_key names the step
-- ('capture', 'reconcile', 'organize' or a custom key). result_json holds the step's structured
-- output, which later steps read.
alter table agent_runs
  add column parent_run_id uuid,
  add column step_key      text,
  add column result_json   jsonb;

-- The kind check was written inline, so find it by what it checks instead of by name.
do $$
declare existing text;
begin
  select conname into existing
  from pg_constraint
  where conrelid = 'agent_runs'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%summarization%';
  if existing is not null then
    execute format('alter table agent_runs drop constraint %I', existing);
  end if;
end $$;

alter table agent_runs
  add constraint agent_runs_kind_check
    check (kind in ('interactive', 'routine', 'synthesis', 'summarization', 'step')),
  add constraint agent_runs_parent_fk
    foreign key (parent_run_id, workspace_id) references agent_runs (id, workspace_id) on delete restrict,
  -- Every step run has a parent, and nothing else does.
  add constraint agent_runs_step_has_parent check ((kind = 'step') = (parent_run_id is not null));

create index agent_runs_parent_idx on agent_runs (parent_run_id) where parent_run_id is not null;
