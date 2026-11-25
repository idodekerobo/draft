-- A routine session always runs in a sandbox. Early routine sessions were inserted before the code set
-- runtime = 'cloud', so the column default 'local' gave them a host target in the expand backfill.
-- The target decides which adapters fit, and the one-shot adapter only runs in a sandbox.
update sessions
set execution_target = 'sandbox'
where session_type = 'routine' and execution_target is distinct from 'sandbox';
