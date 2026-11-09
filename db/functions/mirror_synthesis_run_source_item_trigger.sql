create or replace function mirror_synthesis_run_source_item_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    insert into agent_run_source_items (
      workspace_id, agent_run_id, source_item_id, position, source_item_version, content_hash, created_at
    ) values (
      new.workspace_id, new.synthesis_run_id, new.source_item_id, new.position, new.source_item_version, new.content_hash, new.created_at
    )
    on conflict do nothing;
  exception when others then
    raise warning 'mirror of source item % for run % failed: %', new.source_item_id, new.synthesis_run_id, sqlerrm;
  end;
  return new;
end;
$$;
