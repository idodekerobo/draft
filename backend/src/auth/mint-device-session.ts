import type { SupabaseClient } from "@supabase/supabase-js";
import type { PairingTokens } from "./pairing-store";

export interface MintDeps {
  admin: SupabaseClient;
  anon: SupabaseClient;
}

/** Issues the approving user a session of their own, so a device never shares the browser's refresh token. */
export async function mintDeviceSession(userId: string, { admin, anon }: MintDeps): Promise<PairingTokens | null> {
  const { data: found } = await admin.auth.admin.getUserById(userId);
  const email = found.user?.email;
  if (!email) return null;

  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.properties?.hashed_token;
  if (!tokenHash) return null;

  const { data, error } = await anon.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
  if (error || !data.session) return null;
  const { access_token, refresh_token, expires_at, expires_in } = data.session;
  return { access_token, refresh_token, expires_at, expires_in };
}
