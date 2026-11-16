-- The reasoning effort a session runs with, such as 'low' or 'xhigh'. Null means the harness's own setting.
-- Plain text: the allowed values depend on the model and live in core/src/harnesses, so a new model needs no migration.
alter table sessions add column reasoning_effort text;

-- Viewers see the effort next to the model, so a change must signal them.
drop trigger sessions_signal_update on sessions;
create trigger sessions_signal_update
  after update on sessions
  for each row
  when (
    old.status is distinct from new.status
    or old.title is distinct from new.title
    or old.model is distinct from new.model
    or old.reasoning_effort is distinct from new.reasoning_effort
    or old.permission_mode is distinct from new.permission_mode
    or old.approval_mode is distinct from new.approval_mode
    or old.open_approval_count is distinct from new.open_approval_count
    or old.end_reason is distinct from new.end_reason
    or old.host_name is distinct from new.host_name
  )
  execute function signal_session_row();
