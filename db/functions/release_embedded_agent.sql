-- Gives up the claim at p_epoch, once the process has stopped writing, so another process can take it at once.
create or replace function release_embedded_agent(
  p_session_id uuid,
  p_owner text,
  p_epoch bigint
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update embedded_agent_state
  set payload = jsonb_set(payload, '{expires_at}', to_jsonb(now())),
      updated_at = now()
  where session_id = p_session_id and kind = 'claim' and key = 'owner'
    and payload->>'owner' = p_owner
    and (payload->>'epoch')::bigint = p_epoch;
end;
$$;

revoke all on function release_embedded_agent(uuid, text, bigint) from public;
grant execute on function release_embedded_agent(uuid, text, bigint) to service_role;
