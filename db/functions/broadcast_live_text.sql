-- Sends a piece of the reply an embedded agent (Home) is writing, on "live:session:<id>". Nothing on it is stored, and a
-- piece is provisional: committed events are the record. Who receives it follows the session's row security, so a Home
-- reaches only its owner. A failed send never fails the caller.
create or replace function broadcast_live_text(p_session_id uuid, p_chunk jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from sessions where id = p_session_id and execution_target = 'backend') then
    return;
  end if;
  perform broadcast_signal('live:session:' || p_session_id, 'text', p_chunk);
end;
$$;

revoke all on function broadcast_live_text(uuid, jsonb) from public, anon, authenticated;
grant execute on function broadcast_live_text(uuid, jsonb) to service_role;
