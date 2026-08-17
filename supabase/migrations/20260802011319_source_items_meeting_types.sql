-- Split the generic 'transcript' item_type into 'meeting_transcript' (raw
-- transcript) and 'meeting_notes' (AI-condensed).
--
-- Constraint is swapped before the data migration: the old constraint
-- doesn't allow 'meeting_transcript', so updating existing rows to that
-- value first would violate it.

alter table source_items drop constraint source_items_item_type_check;

alter table source_items add constraint source_items_item_type_check
  check (item_type in ('meeting_transcript', 'meeting_notes', 'message', 'coding_session', 'document', 'provider_event'));

update source_items set item_type = 'meeting_transcript' where item_type = 'transcript';
