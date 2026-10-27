-- Live agent sessions, slice 3: inputs that teammates send into a session.

create table session_inputs (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null,
  workspace_id    uuid not null,
  author_user_id  uuid not null references users(id) on delete cascade,
  author_name     text not null,
  kind            text not null
                    check (kind in ('message', 'permission_decision', 'stop', 'end')),
  payload         jsonb not null default '{}',
  state           text not null default 'queued'
                    check (state in ('queued', 'delivering', 'consumed', 'failed', 'uncertain')),
  -- Why a queued input waits, or why a failed input failed.
  reason          text,
  consumed_seq    bigint,
  dismissed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  foreign key (session_id, workspace_id)
    references sessions(id, workspace_id) on delete cascade
);

create index session_inputs_session_created_idx on session_inputs (session_id, created_at);

alter table session_inputs enable row level security;

create policy session_inputs_select on session_inputs
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = session_inputs.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );

grant select on table session_inputs to authenticated;
grant select, update on table session_inputs to service_role;

-- Adds an input to a session's queue. The author is the caller's user id and
-- display name, taken by the backend from the JWT. An ended session takes no input.
create or replace function create_session_input(
  p_session_id uuid,
  p_workspace_id uuid,
  p_author_user_id uuid,
  p_author_name text,
  p_kind text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_row session_inputs%rowtype;
begin
  select status into v_status
  from sessions
  where id = p_session_id and workspace_id = p_workspace_id
  for share;

  if not found then
    raise exception 'session_not_found';
  end if;
  if v_status = 'ended' then
    raise exception 'session_ended';
  end if;
  if (select count(*) from session_inputs
      where session_id = p_session_id and state = 'queued') >= 20 then
    raise exception 'queue_full';
  end if;

  insert into session_inputs (session_id, workspace_id, author_user_id, author_name, kind, payload)
  values (p_session_id, p_workspace_id, p_author_user_id, p_author_name, p_kind, coalesce(p_payload, '{}'::jsonb))
  returning * into v_row;

  return to_jsonb(v_row);
end;
$$;

-- Input states:
--   queued -> delivering -> consumed
--   queued -> queued (a new reason) | failed
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
    (v_state = 'queued' and p_to in ('queued', 'delivering', 'failed'))
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

revoke all on function create_session_input(uuid, uuid, uuid, text, text, jsonb) from public;
revoke all on function transition_session_input(uuid, uuid, text[], text, text, bigint) from public;
grant execute on function create_session_input(uuid, uuid, uuid, text, text, jsonb) to service_role;
grant execute on function transition_session_input(uuid, uuid, text[], text, text, bigint) to service_role;
