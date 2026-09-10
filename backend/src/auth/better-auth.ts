import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { Pool } from "pg";
import { loadConfig } from "../config";
import { supabaseSessionBridge } from "./better-auth-supabase-bridge-plugin";

const config = loadConfig();

if (!config.betterAuthDatabaseUrl) {
  throw new Error("Missing required env var BETTER_AUTH_DATABASE_URL. Check backend/.env.local.");
}
if (!config.betterAuthSecret) {
  throw new Error("Missing required env var BETTER_AUTH_SECRET. Check backend/.env.local.");
}

// Better Auth has no "target schema" option; search_path puts better_auth
// first so its unqualified table names land there instead of public.
const pool = new Pool({
  connectionString: config.betterAuthDatabaseUrl,
  options: "-c search_path=better_auth,public",
});

/**
 * The shared parent domain (e.g. ".draftai.us") that lets the Better Auth
 * session cookie cross from the web-app origin to the API origin.
 * Returns undefined when the two share a host (e.g. local dev on localhost).
 */
function sharedCookieDomain(a: string, b: string): string | undefined {
  const labelsA = new URL(a).hostname.split(".");
  const labelsB = new URL(b).hostname.split(".");
  let shared = 0;
  while (
    shared < labelsA.length &&
    shared < labelsB.length &&
    labelsA[labelsA.length - 1 - shared] === labelsB[labelsB.length - 1 - shared]
  ) {
    shared++;
  }
  if (shared < 2 || shared === labelsA.length) return undefined; // identical host, or no real subdomain split
  return `.${labelsA.slice(-shared).join(".")}`;
}

const cookieDomain = sharedCookieDomain(config.appUrl, config.apiBaseUrl);

export const auth = betterAuth({
  database: pool,
  secret: config.betterAuthSecret,
  baseURL: config.apiBaseUrl,
  trustedOrigins: [config.appUrl],
  advanced: cookieDomain
    ? { crossSubDomainCookies: { enabled: true, domain: cookieDomain } }
    : undefined,
  plugins: [
    jwt(),
    // mcp() is the OAuth provider itself (wraps @better-auth/oauth-provider);
    // it cannot be combined with a separate oauthProvider() call.
    mcp({
      resource: config.mcpResourceUrl,
      // Absolute web-app URLs — these pages are Next.js routes on the
      // separate app.* origin, not served by this Bun process.
      loginPage: `${config.appUrl}/oauth/login`,
      consentPage: `${config.appUrl}/oauth/consent`,
      scopes: ["read"],
      clientRegistrationDefaultScopes: ["read"],
      // DCR left off for v1 — Claude Code and ChatGPT/Codex both prefer
      // CIMD automatically (allowDynamicClientRegistration defaults false).
    }),
    // CIMD lets clients self-identify via an HTTPS client_id URL instead
    // of calling /oauth2/register.
    cimd({
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
    supabaseSessionBridge(),
  ],
});
