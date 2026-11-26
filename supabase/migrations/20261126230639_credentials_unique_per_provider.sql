-- One login per workspace for the harness providers, across all statuses, so a lookup by
-- (workspace_id, provider) can never see two rows. Keeps the newest active row, else the newest row.
with ranked as (
  select id, workspace_id,
         first_value(id) over (
           partition by workspace_id, provider
           order by (status = 'active') desc, created_at desc, id desc
         ) as survivor_id,
         row_number() over (
           partition by workspace_id, provider
           order by (status = 'active') desc, created_at desc, id desc
         ) as rn
  from credentials
  where provider in ('claude_code', 'codex_chatgpt_auth')
)
update workspaces w
set inference_credential_id = r.survivor_id
from ranked r
where w.inference_credential_id = r.id
  and w.id = r.workspace_id
  and r.rn > 1;

delete from credentials c
using (
  select id,
         row_number() over (
           partition by workspace_id, provider
           order by (status = 'active') desc, created_at desc, id desc
         ) as rn
  from credentials
  where provider in ('claude_code', 'codex_chatgpt_auth')
) d
where c.id = d.id and d.rn > 1;

create unique index credentials_one_harness_login_idx
  on credentials (workspace_id, provider)
  where provider in ('claude_code', 'codex_chatgpt_auth');
