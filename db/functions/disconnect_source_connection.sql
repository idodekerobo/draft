-- Revokes one live provider connection and disables all of its scheduled work
-- in the same transaction. Missing/already-revoked connections are a
-- successful no-op and still return exactly one result row.
create or replace function disconnect_source_connection(
  p_workspace_id uuid,
  p_provider text
)
returns table(connection_id uuid, transitioned boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_id uuid;
begin
  select sc.id into v_connection_id
  from source_connections sc
  where sc.workspace_id = p_workspace_id
    and sc.provider = p_provider
    and sc.status <> 'revoked'
  order by sc.updated_at desc, sc.id desc
  limit 1
  for update;

  if not found then
    return query select null::uuid, false;
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

  return query select v_connection_id, true;
end;
$$;

revoke all on function disconnect_source_connection(uuid, text) from public;
grant execute on function disconnect_source_connection(uuid, text) to service_role;
