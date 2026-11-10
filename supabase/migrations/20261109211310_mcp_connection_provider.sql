-- A remote MCP server a person connected is a source_connections row with provider 'mcp'.
-- connection_key is the server's URL; the bearer token is the connection's credential.
--
-- Other changes rewrite this CHECK with a fixed list. This one adds 'mcp' to whatever list
-- the database has now, so it never drops a provider another change added.
do $$
declare
  current_definition text;
  providers text[];
begin
  select pg_get_constraintdef(oid) into current_definition
  from pg_constraint
  where conrelid = 'source_connections'::regclass
    and conname = 'source_connections_provider_check';

  providers := array(
    select match[1] from regexp_matches(current_definition, '''([a-z_]+)''', 'g') as match
  );
  if cardinality(providers) = 0 then
    raise exception 'source_connections_provider_check not found or has no providers';
  end if;
  if not ('mcp' = any(providers)) then
    providers := array_append(providers, 'mcp');
  end if;

  alter table source_connections drop constraint source_connections_provider_check;
  execute format(
    'alter table source_connections add constraint source_connections_provider_check check (provider in (%s))',
    (select string_agg(quote_literal(provider), ', ') from unnest(providers) as provider)
  );
end $$;
