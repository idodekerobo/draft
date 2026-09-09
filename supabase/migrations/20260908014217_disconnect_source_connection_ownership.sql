-- Old signature (uuid, text) picked "most recently updated" workspace-wide,
-- with no owner parameter at all -- a route-level guard alone can't fix
-- this, since the route doesn't know which connection_id the function will
-- pick. Drop it explicitly: a different arg list creates an overload rather
-- than replacing it.
drop function if exists disconnect_source_connection(uuid, text);

-- Revokes one live provider connection owned by the caller and disables all
-- of its scheduled work in the same transaction. Reports which case
-- occurred ('disconnected' / 'not_found' / 'not_owner') so the route can
-- return the right status without a separate ownership pre-check query --
-- this RPC is the single source of truth for the ownership rule.
create or replace function disconnect_source_connection(
  p_workspace_id uuid,
  p_provider text,
  p_connected_by_user_id uuid
)
returns table(connection_id uuid, outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_id uuid;
  v_owner uuid;
begin
  select sc.id, sc.connected_by_user_id into v_connection_id, v_owner
  from source_connections sc
  where sc.workspace_id = p_workspace_id
    and sc.provider = p_provider
    and sc.status <> 'revoked'
  order by sc.updated_at desc, sc.id desc
  limit 1
  for update;

  if not found then
    return query select null::uuid, 'not_found'::text;
    return;
  end if;

  -- A null owner (older rows, or a provider that was never personally
  -- attributed) is unowned, not "owned by no one" -- anyone with workspace
  -- access may still disconnect it.
  if v_owner is not null and v_owner <> p_connected_by_user_id then
    return query select v_connection_id, 'not_owner'::text;
    return;
  end if;

  update source_connections
  set status = 'revoked'
  where id = v_connection_id
    and workspace_id = p_workspace_id;

  update scheduled_tasks
  set enabled = false
  where source_connection_id = v_connection_id
    and workspace_id = p_workspace_id
    and enabled;

  return query select v_connection_id, 'disconnected'::text;
end;
$$;

revoke all on function disconnect_source_connection(uuid, text, uuid) from public;
grant execute on function disconnect_source_connection(uuid, text, uuid) to service_role;
