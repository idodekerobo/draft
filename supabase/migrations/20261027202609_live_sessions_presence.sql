-- Presence on the private channel "session:<session id>". A person may join and listen when
-- the sessions policy lets them see that session, which means they are a member of its workspace.
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
