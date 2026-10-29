-- The harness list lives in app code (draft-core/harnesses), so a new harness needs no migration.
alter table sessions drop constraint sessions_harness_check;
