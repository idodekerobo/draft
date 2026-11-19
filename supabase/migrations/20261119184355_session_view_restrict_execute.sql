revoke all on function read_session_view(uuid, uuid, text, bigint, bigint, bigint, bigint, integer, boolean) from public, anon, authenticated;
grant execute on function read_session_view(uuid, uuid, text, bigint, bigint, bigint, bigint, integer, boolean) to service_role;
