-- Provisions the public.users row for every Supabase Auth signup (email,
-- OAuth, or otherwise). Without this, a real self-service signup has no
-- public.users row at all -- backend/scripts/seed.ts is the only place that
-- previously created one, via a manual upsert. Fired by the
-- create_user_row_on_signup trigger on auth.users (after insert), defined
-- alongside the invites table in supabase/migrations/. New users start opted
-- in to analytics; they can opt out in Settings.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, status, organization_role, analytics_consent, analytics_consent_at)
  values (new.id, new.email, 'invited', 'member', true, now())
  on conflict (id) do nothing;
  return new;
end;
$$;
