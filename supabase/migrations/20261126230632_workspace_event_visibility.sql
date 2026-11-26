-- Workspace events become the workspace's history: a row is shared with members or private to one person.
alter table workspace_events drop constraint workspace_events_event_type_check;

alter table workspace_events
  add column visibility         text not null default 'shared' check (visibility in ('shared', 'private')),
  add column audience_person_id uuid;

alter table workspace_events
  add constraint workspace_events_audience_fkey
    foreign key (audience_person_id, workspace_id)
    references people(id, workspace_id) on delete set null (audience_person_id);

-- The calling user's person in a workspace. people has no select policy, so RLS reads it through this function.
create or replace function current_user_person_id(p_workspace_id uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select id from public.people where workspace_id = p_workspace_id and user_id = auth.uid();
$$;

revoke all on function current_user_person_id(uuid) from public;
grant execute on function current_user_person_id(uuid) to authenticated, service_role;

drop policy workspace_events_select on workspace_events;
create policy workspace_events_select on workspace_events
  for select to authenticated
  using (
    exists (
      select 1 from workspaces w
      where w.id = workspace_events.workspace_id
        and w.organization_id = current_user_org_id()
        and w.team_id = current_user_team_id()
        and w.access_mode = 'team_default'
    )
    and (
      workspace_events.visibility = 'shared'
      or workspace_events.audience_person_id = current_user_person_id(workspace_events.workspace_id)
    )
  );

-- Allocates the sequence number and inserts in one call, holding the workspace lock until the transaction ends.
create or replace function append_workspace_event(
  p_workspace_id uuid,
  p_event_type text,
  p_summary text,
  p_agent_run_id uuid default null,
  p_connection_id uuid default null,
  p_context_version_id uuid default null,
  p_payload_json jsonb default '{}',
  p_visibility text default 'shared',
  p_audience_person_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sequence bigint;
begin
  v_sequence := next_workspace_event_sequence(p_workspace_id);
  insert into workspace_events (
    workspace_id, sequence_number, event_type, agent_run_id, connection_id, context_version_id,
    summary, payload_json, occurred_at, visibility, audience_person_id
  ) values (
    p_workspace_id, v_sequence, p_event_type, p_agent_run_id, p_connection_id, p_context_version_id,
    p_summary, coalesce(p_payload_json, '{}'), now(), p_visibility, p_audience_person_id
  );
  return v_sequence;
end;
$$;

revoke all on function append_workspace_event(uuid, text, text, uuid, uuid, uuid, jsonb, text, uuid) from public;
grant execute on function append_workspace_event(uuid, text, text, uuid, uuid, uuid, jsonb, text, uuid) to service_role;

-- Backfill: an ingestion event whose connection holds a private source item with the same title was written from it.
-- The title sits in summary for meetings and is a prefix of it for pull requests. Hide those rows from everyone but the owner.
update workspace_events e
set visibility = 'private',
    audience_person_id = (
      select p.id from people p
      where p.workspace_id = e.workspace_id and p.user_id = s.owner_user_id
    )
from source_items s
where e.event_type = 'source_items_added'
  and e.connection_id is not null
  and s.workspace_id = e.workspace_id
  and s.connection_id = e.connection_id
  and s.visibility = 'private'
  and nullif(s.metadata_json->>'title', '') is not null
  and e.summary like '%' || (s.metadata_json->>'title') || '%';
