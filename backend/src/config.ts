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
}

export function loadConfig(): BackendConfig {
  const port = Number(process.env.PORT ?? 8787);
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabasePublishableKey: requireEnv("SUPABASE_PUBLISHABLE_KEY"),
    supabaseSecretKey: requireEnv("SUPABASE_SECRET_KEY"),
    port,
    appUrl: process.env.APP_URL ?? "https://app.draftai.us",
    apiBaseUrl: process.env.API_BASE_URL ?? `http://localhost:${port}`,
  };
}
