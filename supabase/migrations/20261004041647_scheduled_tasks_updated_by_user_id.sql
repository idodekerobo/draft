-- Last member who edited a schedule from the Routines tab. Only the schedules
-- API writes it; ticks, scripts and connect helpers leave it null.
alter table scheduled_tasks
  add column updated_by_user_id uuid references users(id) on delete set null;
