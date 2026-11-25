alter table errors drop constraint errors_operation_check;
alter table errors add constraint errors_operation_check
  check (operation in ('ingestion', 'scheduling', 'queue', 'execution', 'validation', 'commit', 'projection', 'auth',
                       'read', 'session', 'audit', 'delivery'));
