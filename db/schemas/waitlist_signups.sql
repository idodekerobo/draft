-- attribution: first/last-touch UTMs, click ids (ttclid, fbclid), landing url and referrer.
-- profile: optional answers from the post-signup step (how_heard, use_case, team_size).
create table public.waitlist_signups (
  id                  uuid primary key default gen_random_uuid(),
  email               text not null unique,
  source              text,
  created_at          timestamptz not null default now(),
  attribution         jsonb,
  posthog_distinct_id text,
  profile             jsonb
);

alter table public.waitlist_signups enable row level security;
revoke all on public.waitlist_signups from anon, authenticated;
grant insert, select, update on public.waitlist_signups to service_role;
