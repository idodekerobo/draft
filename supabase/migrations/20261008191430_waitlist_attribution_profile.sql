-- attribution: first/last-touch UTMs, click ids (ttclid, fbclid), landing url and referrer.
-- profile: optional answers from the post-signup step (how_heard, use_case, team_size).
alter table public.waitlist_signups
  add column attribution jsonb,
  add column posthog_distinct_id text,
  add column profile jsonb;

-- The profile step updates a row matched by email and posthog_distinct_id.
grant select, update on public.waitlist_signups to service_role;
