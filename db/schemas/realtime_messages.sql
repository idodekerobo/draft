-- Policies this project adds on Supabase's realtime.messages table. The table itself is Supabase's.
-- Presence on the private channel "session:<session id>": allowed when the caller can see that session.
create policy session_presence_select on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'presence'
    and exists (
      select 1 from public.sessions s
      where 'session:' || s.id::text = (select realtime.topic())
    )
  );

create policy session_presence_insert on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'presence'
    and exists (
      select 1 from public.sessions s
      where 'session:' || s.id::text = (select realtime.topic())
    )
  );

-- Signals (broadcast) on "signals:session:<id>" and "signals:workspace:<id>": allowed when the caller can see that session or workspace.
create policy session_broadcast_select on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (select 1 from public.sessions s where s.id = public.realtime_topic_id('signals:session'))
  );

create policy workspace_broadcast_select on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (select 1 from public.workspaces w where w.id = public.realtime_topic_id('signals:workspace'))
  );
