-- What a step run works on: { key, type: 'none' | 'source_batch' | 'document' | 'new_documents', ... }.
-- A step that fans out starts one run per item. The key names the item, so a retry of a failed run
-- is known to repeat the same item.
alter table agent_runs add column step_item jsonb;
