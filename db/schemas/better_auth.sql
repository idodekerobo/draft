-- Better Auth's OAuth 2.1 AS for the remote MCP server (plan 0053). All 12
-- tables below are generated and owned by Better Auth itself
-- (better-auth's getMigrations().compileMigrations(), see
-- supabase/migrations/20260910071637_add_better_auth_schema.sql) -- never
-- hand-edited -- so they're kept in one combined snapshot file rather than
-- one file per table like the rest of db/schemas/: they always change
-- together (a Better Auth version bump regenerates the whole set), and
-- splitting a vendor-owned, always-regenerated schema into 12 near-identical
-- files would add navigation overhead with no corresponding benefit.
--
-- Isolated in its own schema, not exposed through PostgREST (see the
-- migration file for the RLS/grant rationale). Id-matched to
-- public.users.id / auth.users.id by application convention, not a foreign
-- key -- the schemas cannot reference each other, and rows are lazily
-- provisioned on first MCP login, not at signup (see
-- backend/src/auth/better-auth-supabase-bridge-plugin.ts) -- most
-- Supabase users have no better_auth.user row at all.

create schema if not exists better_auth;

create table better_auth."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table better_auth."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references better_auth."user" ("id") on delete cascade);

create table better_auth."account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references better_auth."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table better_auth."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table better_auth."jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);

create table better_auth."oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references better_auth."user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);

create table better_auth."oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

create table better_auth."oauthClientResource" ("id" text not null primary key, "clientId" text not null references better_auth."oauthClient" ("clientId") on delete cascade, "resourceId" text not null references better_auth."oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

create table better_auth."oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references better_auth."oauthClient" ("clientId") on delete cascade, "sessionId" text references better_auth."session" ("id") on delete set null, "userId" text not null references better_auth."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table better_auth."oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references better_auth."oauthClient" ("clientId") on delete cascade, "sessionId" text references better_auth."session" ("id") on delete set null, "userId" text references better_auth."user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references better_auth."oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table better_auth."oauthConsent" ("id" text not null primary key, "clientId" text not null references better_auth."oauthClient" ("clientId") on delete cascade, "userId" text references better_auth."user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table better_auth."oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);

-- Direct-pg-connection role for Better Auth (not PostgREST/service_role) --
-- least-privilege, scoped to only this schema.
grant usage on schema better_auth to better_auth_service;
grant all on all tables in schema better_auth to better_auth_service;
grant all on all sequences in schema better_auth to better_auth_service;
