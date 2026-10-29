-- A sender's Stop withdraws their own message while it is still queued.
alter table session_inputs drop constraint session_inputs_state_check;
alter table session_inputs add constraint session_inputs_state_check
  check (state in ('queued', 'delivering', 'consumed', 'failed', 'uncertain', 'cancelled'));

-- Input states:
--   queued -> delivering -> consumed
--   queued -> queued (a new reason) | failed | cancelled
--   delivering -> uncertain | failed | consumed
--   uncertain -> consumed
-- Moves one input to a new state only if it is in one of the p_from states.
-- Returns false when the input is in another state, so a late writer changes nothing.
create or replace function transition_session_input(
  p_input_id uuid,
  p_session_id uuid,
  p_from text[],
  p_to text,
  p_reason text,
  p_consumed_seq bigint
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
  v_count integer;
begin
  select state into v_state
  from session_inputs
  where id = p_input_id and session_id = p_session_id
  for update;

  if not found or not (v_state = any(p_from)) then
    return false;
  end if;

  if not (
    (v_state = 'queued' and p_to in ('queued', 'delivering', 'failed', 'cancelled'))
    or (v_state = 'delivering' and p_to in ('uncertain', 'failed', 'consumed'))
    or (v_state = 'uncertain' and p_to = 'consumed')
  ) then
    raise exception 'invalid_transition';
  end if;

  update session_inputs
  set state = p_to,
      reason = p_reason,
      consumed_seq = coalesce(p_consumed_seq, consumed_seq),
      updated_at = now()
  where id = p_input_id and session_id = p_session_id;

  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function transition_session_input(uuid, uuid, text[], text, text, bigint) from public;
grant execute on function transition_session_input(uuid, uuid, text[], text, text, bigint) to service_role;
