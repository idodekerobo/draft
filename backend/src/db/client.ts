import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "../config";

const config = loadConfig();

export const serviceClient: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabaseSecretKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export function userClient(accessToken: string): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabasePublishableKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export const publishableClient: SupabaseClient = createClient(
  config.supabaseUrl,
  config.supabasePublishableKey,
  { auth: { autoRefreshToken: false, persistSession: false } },
);
