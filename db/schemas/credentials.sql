-- TODO: no RLS policies are defined for `authenticated` on this table by design.
-- RLS is enabled with zero policies, so ordinary user/desktop roles get zero
-- rows; only the trusted service role (which bypasses RLS in Supabase) may
-- read secret payloads. Do not add an `authenticated` select policy here.
-- TODO: `provider` has no CHECK constraint. Allowed values live only in the
-- CredentialProvider TS union (backend/src/types/enums.ts) -- update that
-- type, not this file, when adding a value.
create table credentials (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null references workspaces(id) on delete cascade,
  provider                 text not null,
  label                    text,
  encrypted_payload        bytea not null,
  encryption_key_version   text not null,
  status                   text not null default 'active'
                              check (status in ('active', 'revoked', 'expired')),
  expires_at               timestamptz,
  last_used_at             timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  unique (id, workspace_id)
);
