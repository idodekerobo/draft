-- The reasoning effort a run was started with, such as 'low' or 'xhigh'. Null means the harness's own setting.
-- Plain text: the allowed values depend on the model and live in core/src/harnesses.
alter table agent_runs add column reasoning_effort text;
