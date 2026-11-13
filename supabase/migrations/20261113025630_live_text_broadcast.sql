-- Live text (broadcast) on "live:session:<id>": anyone who can see the session receives it. Only its owner, whose
-- computer runs it, may send.
create policy session_live_text_select on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (select 1 from public.sessions s where s.id = public.realtime_topic_id('live:session'))
  );

create policy session_live_text_insert on realtime.messages
  for insert to authenticated
  with check (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from public.sessions s
      where s.id = public.realtime_topic_id('live:session') and s.owner_user_id = (select auth.uid())
    )
  );
