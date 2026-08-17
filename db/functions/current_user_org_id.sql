-- RLS helper: the calling user's organization_id, used by every
-- organization-scoped select policy.
create or replace function current_user_org_id()
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select organization_id from public.users where id = auth.uid();
$$;
