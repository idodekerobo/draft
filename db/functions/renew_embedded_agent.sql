-- Extends the claim of the process that still holds it at p_epoch. False when the claim expired or moved on: the process
-- must then stop admitting work and stop writing. An expired claim is not renewed even if nobody took it.
create or replace function renew_embedded_agent(
  p_session_id uuid,
  p_owner text,
  p_epoch bigint,
  p_ttl interval
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  update embedded_agent_state
  set payload = jsonb_set(payload, '{expires_at}', to_jsonb(now() + p_ttl)),
      updated_at = now()
  where session_id = p_session_id and kind = 'claim' and key = 'owner'
    and payload->>'owner' = p_owner
    and (payload->>'epoch')::bigint = p_epoch
    and (payload->>'expires_at')::timestamptz > now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function renew_embedded_agent(uuid, text, bigint, interval) from public;
grant execute on function renew_embedded_agent(uuid, text, bigint, interval) to service_role;
