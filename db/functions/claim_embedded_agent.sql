-- Takes, or renews, the claim on an embedded agent (Home): which backend process drives it. One owner at a time.
-- Claimed when nobody holds it, when p_owner already does, or when the holder's claim has expired. A new owner, or a claim
-- that had expired, gets a higher epoch. Every commit checks the epoch, so a process that lost the claim cannot write.
-- p_owner is unique per process start. Returns { claimed, epoch, owner }.
create or replace function claim_embedded_agent(
  p_session_id uuid,
  p_owner text,
  p_ttl interval
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payload jsonb;
  v_holder text;
  v_epoch bigint;
  v_live boolean;
begin
  insert into embedded_agent_state (session_id, kind, key, payload)
  values (p_session_id, 'claim', 'owner', '{}')
  on conflict (session_id, kind, key) do nothing;

  select payload into v_payload
  from embedded_agent_state
  where session_id = p_session_id and kind = 'claim' and key = 'owner'
  for update;

  v_holder := v_payload->>'owner';
  v_epoch := coalesce((v_payload->>'epoch')::bigint, 0);
  v_live := v_holder is not null and (v_payload->>'expires_at')::timestamptz > now();

  if v_live and v_holder is distinct from p_owner then
    return jsonb_build_object('claimed', false, 'epoch', v_epoch, 'owner', v_holder);
  end if;
  if not v_live or v_holder is distinct from p_owner then
    v_epoch := v_epoch + 1;
  end if;

  update embedded_agent_state
  set payload = jsonb_build_object('owner', p_owner, 'epoch', v_epoch, 'expires_at', now() + p_ttl),
      updated_at = now()
  where session_id = p_session_id and kind = 'claim' and key = 'owner';
  return jsonb_build_object('claimed', true, 'epoch', v_epoch, 'owner', p_owner);
end;
$$;

revoke all on function claim_embedded_agent(uuid, text, interval) from public;
grant execute on function claim_embedded_agent(uuid, text, interval) to service_role;
