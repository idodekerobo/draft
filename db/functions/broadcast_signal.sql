-- Sends one signal. A failed send must never fail the write that caused it.
create or replace function broadcast_signal(p_topic text, p_event text, p_payload jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform realtime.send(p_payload, p_event, p_topic, true);
exception when others then
  raise warning 'broadcast_signal failed for %: %', p_topic, sqlerrm;
end;
$$;

revoke all on function broadcast_signal(text, text, jsonb) from public, anon, authenticated;
