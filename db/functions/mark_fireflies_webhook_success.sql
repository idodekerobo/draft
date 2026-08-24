-- Advances webhook readiness only for the credential generation that
-- authenticated the delivery.
create or replace function mark_fireflies_webhook_success(
  p_workspace_id uuid,
  p_connection_id uuid,
  p_credential_id uuid,
  p_succeeded_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update source_connections
  set last_success_at = p_succeeded_at
  where id = p_connection_id
    and workspace_id = p_workspace_id
    and provider = 'fireflies'
    and credential_id = p_credential_id
    and status in ('active', 'degraded');

  return found;
end;
$$;

revoke all on function mark_fireflies_webhook_success(
  uuid, uuid, uuid, timestamptz
) from public;
grant execute on function mark_fireflies_webhook_success(
  uuid, uuid, uuid, timestamptz
) to service_role;
