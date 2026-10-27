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
