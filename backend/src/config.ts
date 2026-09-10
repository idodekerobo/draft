function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name}. Check backend/.env.local.`,
    );
  }
  return value;
}

export interface BackendConfig {
  supabaseUrl: string;
  supabasePublishableKey: string;
  supabaseSecretKey: string;
  port: number;
  appUrl: string;
  apiBaseUrl: string;
  githubAppId: string;
  githubAppSlug: string;
  githubAppPrivateKey: string;
  githubAppPrivateKeyPrevious?: string;
  githubAppWebhookSecret: string;
  // Optional (not requireEnv) since loadConfig() is called broadly; only
  // src/auth/better-auth.ts needs these and validates them itself.
  betterAuthDatabaseUrl: string | undefined;
  betterAuthSecret: string | undefined;
  // MCP resource identifier (RFC 8707/9728) — always apiBaseUrl + "/mcp".
  mcpResourceUrl: string;
}

// GITHUB_APP_PRIVATE_KEY is stored with literal \n escapes (see
// scripts/create-github-app.ts's output) since it must fit on one env-var
// line; restore it to a real multi-line PEM here.
function unescapePem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

export function loadConfig(): BackendConfig {
  const port = Number(process.env.PORT ?? 8787);
  const githubAppPrivateKeyPreviousRaw = process.env.GITHUB_APP_PRIVATE_KEY_PREVIOUS;
  const apiBaseUrl = process.env.DRAFT_API_BASE_URL ?? `http://localhost:${port}`;
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabasePublishableKey: requireEnv("SUPABASE_PUBLISHABLE_KEY"),
    supabaseSecretKey: requireEnv("SUPABASE_SECRET_KEY"),
    port,
    appUrl: process.env.APP_URL ?? "https://app.draftai.us",
    apiBaseUrl,
    githubAppId: requireEnv("GITHUB_APP_ID"),
    githubAppSlug: requireEnv("GITHUB_APP_SLUG"),
    githubAppPrivateKey: unescapePem(requireEnv("GITHUB_APP_PRIVATE_KEY")),
    githubAppPrivateKeyPrevious: githubAppPrivateKeyPreviousRaw
      ? unescapePem(githubAppPrivateKeyPreviousRaw)
      : undefined,
    githubAppWebhookSecret: requireEnv("GITHUB_APP_WEBHOOK_SECRET"),
    betterAuthDatabaseUrl: process.env.BETTER_AUTH_DATABASE_URL,
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    mcpResourceUrl: `${apiBaseUrl}/mcp`,
  };
}
