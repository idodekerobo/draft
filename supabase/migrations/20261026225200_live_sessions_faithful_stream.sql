-- Live agent sessions, slice 2: tool, thinking and note events, and the raw
-- transcript upload (columns plus the session-raw bucket).

alter table session_events drop constraint session_events_kind_check;
alter table session_events add constraint session_events_kind_check
  check (kind in ('user_message', 'assistant_text', 'tool_use', 'tool_result', 'thinking', 'session_note'));

alter table sessions
  add column raw_storage_path text,
  add column raw_uploaded_at timestamptz;

-- Private. The backend hands the host signed upload URLs, so there is no
-- authenticated write path. Workspace members can read their own workspace's
-- objects.
--
-- Object key convention:
--   <workspace_id>/<session_id>/root.jsonl.gz
--   <workspace_id>/<session_id>/subagents/agent-<id>.jsonl.gz
insert into storage.buckets (id, name, public)
values ('session-raw', 'session-raw', false)
on conflict (id) do nothing;

create policy session_raw_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'session-raw'
    and exists (
      select 1 from public.workspaces w
      where w.id::text = (storage.foldername(storage.objects.name))[1]
        and w.organization_id = public.current_user_org_id()
        and w.team_id = public.current_user_team_id()
        and w.access_mode = 'team_default'
    )
  );
