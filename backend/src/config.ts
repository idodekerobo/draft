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
}

export function loadConfig(): BackendConfig {
  return {
    supabaseUrl: requireEnv("SUPABASE_URL"),
    supabasePublishableKey: requireEnv("SUPABASE_PUBLISHABLE_KEY"),
    supabaseSecretKey: requireEnv("SUPABASE_SECRET_KEY"),
    port: Number(process.env.PORT ?? 8787),
    appUrl: process.env.APP_URL ?? "https://app.draftai.us",
  };
}
