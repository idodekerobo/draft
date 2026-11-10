/** The secret run tokens are signed with. Run tokens use a key derived from it, so they cannot be confused with callback tokens. */
export function runTokenSecret(env: Record<string, string | undefined> = process.env): string {
  const secret = env.SANDBOX_CALLBACK_SECRET;
  if (!secret) throw new Error("Missing required env var SANDBOX_CALLBACK_SECRET");
  return secret;
}
