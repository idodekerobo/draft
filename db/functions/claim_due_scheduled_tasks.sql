-- Claims due timers with SKIP LOCKED. Agent routines get their agent_event_inbox row in this
-- same transaction, so a crash after the claim can't lose a one-shot. Other tasks get a
-- provisional next_due_at (p_now + lease) that the caller replaces; SQL can't parse cron.
-- claimed_occurrence_at keeps the real occurrence until the caller advances the row, so a
-- reclaim after a crash reuses it and the event's dedupe key, instead of firing again.
create or replace function claim_due_scheduled_tasks(
  p_now timestamptz,
  p_limit int,
  p_lease_seconds int
)
returns table (task jsonb, occurrence_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
begin
  return query
    with due as (
      select s.id, coalesce(s.claimed_occurrence_at, s.next_due_at) as occurrence_at
      from scheduled_tasks s
      where s.enabled
        and s.deleted_at is null
        and s.next_due_at is not null
        and s.next_due_at <= p_now
      order by s.next_due_at
      limit p_limit
      for update skip locked
    ), routine_events as (
      insert into agent_event_inbox (workspace_id, scheduled_task_id, origin, event_name, dedupe_key, concurrency_key, payload)
      select t.workspace_id, t.id, 'schedule', 'timer.fired',
             t.id::text || ':timer:' || to_char(d.occurrence_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             t.id::text,
             jsonb_build_object(
               'type', 'timer',
               'occurrenceAt', to_char(d.occurrence_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             )
      from scheduled_tasks t
      join due d on d.id = t.id
      where t.task_type = 'agent_routine'
      on conflict (workspace_id, dedupe_key) do nothing
    )
    update scheduled_tasks t set
      last_enqueued_at = p_now,
      fired_at    = case when t.schedule_kind = 'once' then p_now else t.fired_at end,
      enabled     = case when t.schedule_kind = 'once' then false else t.enabled end,
      claimed_occurrence_at = case when t.schedule_kind = 'once' then null else due.occurrence_at end,
      next_due_at = case when t.schedule_kind = 'once' then null
                         else p_now + make_interval(secs => p_lease_seconds) end
    from due
    where t.id = due.id
    returning to_jsonb(t.*), due.occurrence_at;
end;
$$;

revoke all on function claim_due_scheduled_tasks(timestamptz, int, int) from public;
grant execute on function claim_due_scheduled_tasks(timestamptz, int, int) to service_role;
